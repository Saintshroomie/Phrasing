import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    substituteParams,
    generateRaw,
} from '../../../../script.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const EXTENSION_NAME = 'Phrasing';
const INJECTION_KEY = 'phrasing_instruction';

const DEFAULT_PHRASING_PROMPT = `[Rewrite the following message. Preserve its meaning, intent, and any dialogue, but enrich it with narration, action, and detail consistent with the character and the current scene. Do not continue the scene beyond what the original message describes.

{{phrasingSeed}}]`;

const defaultSettings = {
    enabled: true,
    debugMode: false,
};

// ── State ──────────────────────────────────────────────────────────────────────

let settings = { ...defaultSettings };
let phrasingActive = false; // true while a character-message Phrasing! swipe generation is running
let phrasingUserActive = false; // true while a user-message Phrasing! generateRaw call is running

// ── Helpers ────────────────────────────────────────────────────────────────────

function debug(...args) {
    if (!settings.debugMode) return;
    console.log('PHRASING-DEBUG:', ...args);
}

function toast(message, type = 'info') {
    if (typeof toastr !== 'undefined' && toastr[type]) {
        toastr[type](message);
    }
}

function getContext() {
    return SillyTavern.getContext();
}

/**
 * Returns the active prompt template for the current chat.
 * Priority: chat metadata → extension default.
 */
function getActivePrompt() {
    const context = getContext();
    const chatPrompt = context.chatMetadata?.phrasing?.prompt;
    const source = chatPrompt ? 'chat metadata' : 'default';
    debug('getActivePrompt — source:', source);
    return chatPrompt || DEFAULT_PHRASING_PROMPT;
}

/**
 * Assembles the final prompt by replacing {{phrasingSeed}} and resolving ST macros.
 */
function assemblePrompt(seedText) {
    debug('assemblePrompt — seed text length:', seedText.length, '| preview:', seedText.substring(0, 80));
    let prompt = getActivePrompt();
    prompt = prompt.replace(/\{\{phrasingSeed\}\}/g, seedText);
    prompt = substituteParams(prompt);
    debug('assemblePrompt — final prompt length:', prompt.length);
    return prompt;
}

/**
 * Injects the assembled Phrasing! prompt at depth 0, System role.
 */
function injectPhrasingPrompt(assembledPrompt) {
    debug('injectPhrasingPrompt — injecting at depth 0, SYSTEM role, prompt length:', assembledPrompt.length);
    setExtensionPrompt(
        INJECTION_KEY,
        assembledPrompt,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

/**
 * Clears the ephemeral Phrasing! injection.
 */
function clearPhrasingInjection() {
    debug('clearPhrasingInjection — removing injection');
    setExtensionPrompt(INJECTION_KEY, '', extension_prompt_types.NONE, 0);
}

// ── Button Visibility ──────────────────────────────────────────────────────────

function hideAllPhrasingButtons() {
    const buttons = document.querySelectorAll('.phrasing-trigger');
    debug('hideAllPhrasingButtons — hiding', buttons.length, 'buttons');
    buttons.forEach(el => {
        el.classList.add('phrasing-hidden');
    });
}

function showAllPhrasingButtons() {
    if (!settings.enabled) {
        debug('showAllPhrasingButtons — skipped, extension disabled');
        return;
    }
    const buttons = document.querySelectorAll('.phrasing-trigger');
    debug('showAllPhrasingButtons — showing', buttons.length, 'buttons');
    buttons.forEach(el => {
        el.classList.remove('phrasing-hidden');
    });
}

function applyEnabledState() {
    debug('applyEnabledState — enabled:', settings.enabled);
    if (settings.enabled) {
        showAllPhrasingButtons();
    } else {
        hideAllPhrasingButtons();
    }
}

// ── Core Flows ─────────────────────────────────────────────────────────────────

/**
 * Primary Flow (§2.1): Posts seed text as a user message, then generates a
 * Phrasing! swipe on that user message via generateRaw.
 * Returns the generated enriched text.
 */
async function doPrimaryFlow(seedText) {
    debug('doPrimaryFlow — starting with seed length:', seedText.length, '| preview:', seedText.substring(0, 80));
    const context = getContext();

    if (context.isGenerating) {
        debug('doPrimaryFlow — ABORTED: generation already in progress');
        return '';
    }
    if (phrasingUserActive) {
        debug('doPrimaryFlow — ABORTED: user phrasing already in progress');
        return '';
    }

    // 1. Post the raw seed text as a real user message (becomes swipe 0).
    debug('doPrimaryFlow — posting seed text via /send');
    await context.executeSlashCommandsWithOptions(`/send ${seedText}`);

    // 2. Brief wait for the message to be fully added to the chat array and rendered.
    debug('doPrimaryFlow — waiting 300ms for message render');
    await new Promise(resolve => setTimeout(resolve, 300));

    // 3. Generate the enriched swipe on the (now last) user message.
    const lastMessageIndex = context.chat.length - 1;
    debug('doPrimaryFlow — generating enriched swipe on message index:', lastMessageIndex);
    return await doUserMessagePhrasing(lastMessageIndex);
}

/**
 * Swipe-Mode Flow (§2.3): Reads the currently displayed swipe of an existing
 * message and triggers a guided Phrasing! swipe.
 * For user messages, uses generateRaw directly (swipe buttons are not natively
 * present on user messages in ST). For character messages, uses ST's swipe
 * mechanism via the injected prompt.
 * Returns the generated enriched text.
 */
async function doSwipeMode(messageIndex) {
    debug('doSwipeMode — starting for message index:', messageIndex);
    const context = getContext();

    if (context.isGenerating) {
        debug('doSwipeMode — ABORTED: generation already in progress');
        return '';
    }

    const message = context.chat[messageIndex];
    if (!message) {
        debug('doSwipeMode — ABORTED: no message at index', messageIndex);
        return '';
    }

    const seedText = message.mes;
    if (!seedText || !seedText.trim()) {
        debug('doSwipeMode — ABORTED: message is empty');
        toast('Cannot rephrase an empty message.', 'warning');
        return '';
    }

    // User messages don't have native ST swipe buttons — use the direct generateRaw path.
    if (message.is_user) {
        debug('doSwipeMode — user message detected, delegating to doUserMessagePhrasing');
        return await doUserMessagePhrasing(messageIndex);
    }

    // Character message path: inject prompt and trigger via swipe_right.
    debug('doSwipeMode — character message, seed length:', seedText.length, '| swipe_id:', message.swipe_id);
    phrasingActive = true;
    debug('doSwipeMode — phrasingActive set to true');

    // Ensure swipe array exists.
    if (!message.swipes || message.swipes.length === 0) {
        debug('doSwipeMode — initializing swipes array for message');
        message.swipes = [message.mes];
        message.swipe_id = 0;
        message.swipe_info = [{}];
    } else {
        debug('doSwipeMode — existing swipes count:', message.swipes.length, '| current swipe_id:', message.swipe_id);
    }

    // Assemble and inject the prompt.
    const assembled = assemblePrompt(seedText);
    injectPhrasingPrompt(assembled);

    // Trigger a swipe-right on the target message.
    const messageEl = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageEl) {
        const swipeRight = messageEl.querySelector('.swipe_right');
        if (swipeRight) {
            debug('doSwipeMode — clicking swipe_right to generate new swipe');
            swipeRight.click();
        } else {
            debug('doSwipeMode — FAILED: swipe_right button not found on message', messageIndex);
            clearPhrasingInjection();
            phrasingActive = false;
            return '';
        }
    } else {
        debug('doSwipeMode — FAILED: message element not found for index', messageIndex);
        clearPhrasingInjection();
        phrasingActive = false;
        return '';
    }

    // Wait for generation to complete.
    debug('doSwipeMode — waiting for generation to complete');
    const result = await waitForGenerationEnd();
    debug('doSwipeMode — generation complete, result length:', result.length);
    return result;
}

// ── User Message Phrasing ─────────────────────────────────────────────────────

/**
 * Generates a Phrasing! swipe for a user message using generateRaw directly.
 * ST does not render swipe buttons for user messages, so we call the LLM
 * ourselves and manually inject swipe controls into the DOM.
 */
async function doUserMessagePhrasing(messageIndex) {
    debug('doUserMessagePhrasing — starting for message index:', messageIndex);

    if (phrasingUserActive) {
        debug('doUserMessagePhrasing — ABORTED: user phrasing already in progress');
        return '';
    }

    const context = getContext();
    const message = context.chat[messageIndex];
    if (!message) {
        debug('doUserMessagePhrasing — ABORTED: no message at index', messageIndex);
        return '';
    }

    const seedText = message.mes;
    if (!seedText?.trim()) {
        debug('doUserMessagePhrasing — ABORTED: empty message');
        toast('Cannot rephrase an empty message.', 'warning');
        return '';
    }

    phrasingUserActive = true;
    hideAllPhrasingButtons();

    try {
        // Initialize swipes array if this is the first swipe.
        if (!message.swipes || message.swipes.length === 0) {
            debug('doUserMessagePhrasing — initializing swipes array');
            message.swipes = [message.mes];
            message.swipe_id = 0;
            message.swipe_info = [{}];
        } else {
            debug('doUserMessagePhrasing — existing swipes count:', message.swipes.length);
        }

        const assembled = assemblePrompt(seedText);
        debug('doUserMessagePhrasing — calling generateRaw, prompt length:', assembled.length);

        const result = await generateRaw({ prompt: assembled });
        debug('doUserMessagePhrasing — result length:', result ? result.length : 0);

        if (!result?.trim()) {
            debug('doUserMessagePhrasing — empty result, aborting swipe creation');
            toast('Phrasing! returned an empty response.', 'warning');
            return '';
        }

        // Add the enriched text as a new swipe.
        message.swipes.push(result.trim());
        message.swipe_info.push({});
        message.swipe_id = message.swipes.length - 1;
        message.mes = result.trim();

        await context.saveChat();

        // Update the message DOM to show the new text and swipe controls.
        const messageEl = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
        if (messageEl) {
            updateUserMessageDisplay(messageEl, message, messageIndex);
            ensureUserSwipeControls(messageEl, message, messageIndex);
        }

        debug('doUserMessagePhrasing — complete, swipe_id now:', message.swipe_id);
        return result.trim();
    } catch (err) {
        debug('doUserMessagePhrasing — generateRaw threw:', err);
        toast('Phrasing! generation failed.', 'error');
        return '';
    } finally {
        phrasingUserActive = false;
        showAllPhrasingButtons();
    }
}

/**
 * Updates the visible text of a user message element to reflect message.mes.
 */
function updateUserMessageDisplay(messageEl, msg, messageIndex) {
    const mesTextEl = messageEl.querySelector('.mes_text');
    if (!mesTextEl) return;

    const context = getContext();
    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(
            msg.mes, msg.name, msg.is_system, msg.is_user, messageIndex,
        );
    } else {
        mesTextEl.textContent = msg.mes;
    }
}

/**
 * Injects (or updates) the Phrasing! swipe navigation controls for a user
 * message. Called after generating a swipe and on chat reload.
 */
function ensureUserSwipeControls(messageEl, msg, messageIndex) {
    if (!msg.swipes || msg.swipes.length <= 1) return;

    // Remove stale controls so we rebuild with fresh event listeners.
    messageEl.querySelector('.phrasing-user-swipes')?.remove();

    const container = document.createElement('div');
    container.classList.add('phrasing-user-swipes');

    const leftBtn = document.createElement('div');
    leftBtn.classList.add('phrasing-user-swipe-btn', 'interactable');
    leftBtn.title = 'Previous version';
    leftBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    leftBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateUserMessageSwipe(messageIndex, -1);
    });

    const counter = document.createElement('span');
    counter.classList.add('phrasing-user-swipe-counter');
    counter.textContent = `${(msg.swipe_id ?? 0) + 1}/${msg.swipes.length}`;

    const rightBtn = document.createElement('div');
    rightBtn.classList.add('phrasing-user-swipe-btn', 'interactable');
    rightBtn.title = 'Next version';
    rightBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    rightBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateUserMessageSwipe(messageIndex, +1);
    });

    container.appendChild(leftBtn);
    container.appendChild(counter);
    container.appendChild(rightBtn);

    const mesBlock = messageEl.querySelector('.mes_block') || messageEl;
    mesBlock.appendChild(container);
    debug('ensureUserSwipeControls — controls added for message', messageIndex, '| swipes:', msg.swipes.length);
}

/**
 * Navigates a user message's swipe array by direction (-1 or +1).
 */
async function navigateUserMessageSwipe(messageIndex, direction) {
    const context = getContext();
    const msg = context.chat[messageIndex];
    if (!msg?.swipes) return;

    const newId = Math.max(0, Math.min(msg.swipes.length - 1, (msg.swipe_id ?? 0) + direction));
    if (newId === msg.swipe_id) return;

    debug('navigateUserMessageSwipe — index:', messageIndex, '| direction:', direction, '| newId:', newId);
    msg.swipe_id = newId;
    msg.mes = msg.swipes[newId];

    await context.saveChat();

    const messageEl = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageEl) {
        updateUserMessageDisplay(messageEl, msg, messageIndex);
        ensureUserSwipeControls(messageEl, msg, messageIndex);
    }
}

/**
 * Restores user message swipe controls for any messages that already have
 * multiple swipes (e.g., after a chat load or scroll).
 */
function restoreUserSwipeControls() {
    const context = getContext();
    context.chat.forEach((msg, index) => {
        if (!msg.is_user || !msg.swipes || msg.swipes.length <= 1) return;
        const messageEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (messageEl) {
            ensureUserSwipeControls(messageEl, msg, index);
        }
    });
    debug('restoreUserSwipeControls — scan complete');
}

/**
 * Returns a promise that resolves when the current generation ends.
 * Resolves with the last message's text (the generated swipe content).
 */
function waitForGenerationEnd() {
    debug('waitForGenerationEnd — subscribing to GENERATION_ENDED/GENERATION_STOPPED');
    return new Promise(resolve => {
        const context = getContext();
        const { eventSource, eventTypes } = context;

        const onEnd = () => {
            debug('waitForGenerationEnd — generation ended event received');
            eventSource.removeListener(eventTypes.GENERATION_ENDED, onEnd);
            eventSource.removeListener(eventTypes.GENERATION_STOPPED, onEnd);
            // Return the content of the currently active swipe of the last message.
            const ctx = getContext();
            const lastMsg = ctx.chat[ctx.chat.length - 1];
            debug('waitForGenerationEnd — last message length:', lastMsg ? lastMsg.mes.length : 0, '| swipe_id:', lastMsg?.swipe_id);
            resolve(lastMsg ? lastMsg.mes : '');
        };

        eventSource.on(eventTypes.GENERATION_ENDED, onEnd);
        if (eventTypes.GENERATION_STOPPED) {
            eventSource.on(eventTypes.GENERATION_STOPPED, onEnd);
        }
    });
}

// ── Button Handlers ────────────────────────────────────────────────────────────

/**
 * Handler for the input area button and hamburger menu button.
 * If input is empty, falls back to Impersonate.
 */
async function onInputPhrasingClick() {
    debug('onInputPhrasingClick — triggered');
    if (!settings.enabled) {
        debug('onInputPhrasingClick — ABORTED: extension disabled');
        return;
    }

    const context = getContext();
    if (context.isGenerating) {
        debug('onInputPhrasingClick — ABORTED: generation in progress');
        return;
    }

    const textarea = document.getElementById('send_textarea');
    const seedText = textarea?.value?.trim();

    if (!seedText) {
        debug('onInputPhrasingClick — no input text, falling back to impersonate');
        // Empty input → Impersonate fallback
        const impersonateBtn = document.getElementById('option_impersonate');
        if (impersonateBtn) {
            impersonateBtn.click();
        }
        return;
    }

    debug('onInputPhrasingClick — seed text captured, length:', seedText.length);
    // Clear the input field.
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    await doPrimaryFlow(seedText);
}

/**
 * Handler for the message action button.
 */
async function onMessagePhrasingClick(messageIndex) {
    debug('onMessagePhrasingClick — triggered for message index:', messageIndex);
    if (!settings.enabled) {
        debug('onMessagePhrasingClick — ABORTED: extension disabled');
        return;
    }

    const context = getContext();
    if (context.isGenerating) {
        debug('onMessagePhrasingClick — ABORTED: generation in progress');
        return;
    }

    // Only allow on the last message.
    const lastIndex = context.chat.length - 1;
    if (messageIndex !== lastIndex) {
        debug('onMessagePhrasingClick — ABORTED: message', messageIndex, 'is not the last message (last:', lastIndex, ')');
        toast('Phrasing! can only be used on the last message.', 'warning');
        return;
    }

    await doSwipeMode(messageIndex);
}

// ── Message Action Button Management ───────────────────────────────────────────

/**
 * Adds the Phrasing! button to the last message's action area.
 * Removes it from all other messages.
 */
function updateMessageActionButtons() {
    debug('updateMessageActionButtons — called');
    if (!settings.enabled) {
        debug('updateMessageActionButtons — skipped, extension disabled');
        return;
    }

    const context = getContext();
    const lastIndex = context.chat.length - 1;

    // Remove existing phrasing buttons from all messages.
    const existingButtons = document.querySelectorAll('.phrasing_mes_button');
    debug('updateMessageActionButtons — removing', existingButtons.length, 'existing buttons, targeting last index:', lastIndex);
    existingButtons.forEach(el => el.remove());

    if (lastIndex < 0) {
        debug('updateMessageActionButtons — no messages in chat');
        return;
    }

    const lastMessageEl = document.querySelector(`#chat .mes[mesid="${lastIndex}"]`);
    if (!lastMessageEl) {
        debug('updateMessageActionButtons — last message element not found in DOM');
        return;
    }

    // Find the extra mes buttons area (where swipe buttons and other actions live).
    const extraButtons = lastMessageEl.querySelector('.extraMesButtons, .mes_buttons');
    if (!extraButtons) {
        debug('updateMessageActionButtons — extraMesButtons/mes_buttons container not found');
        return;
    }

    const btn = document.createElement('div');
    btn.classList.add('phrasing_mes_button', 'phrasing-trigger', 'mes_button', 'fa-solid', 'fa-pen-fancy', 'interactable');
    btn.title = 'Phrasing! — Add a rephrased swipe';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mesId = parseInt(lastMessageEl.getAttribute('mesid'));
        onMessagePhrasingClick(mesId);
    });

    // Don't add if generation is in progress.
    if (context.isGenerating) {
        btn.classList.add('phrasing-hidden');
    }

    extraButtons.appendChild(btn);
    debug('updateMessageActionButtons — button added to message', lastIndex, '| hidden:', context.isGenerating);
}

// ── Settings Management ────────────────────────────────────────────────────────

function loadSettings() {
    const context = getContext();
    const saved = context.extensionSettings?.phrasing;
    if (saved) {
        settings = { ...defaultSettings, ...saved };
    }
    debug('loadSettings — loaded:', JSON.stringify(settings));
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings.phrasing = { ...settings };
    context.saveSettings();
    debug('saveSettings — saved:', JSON.stringify(settings));
}

function loadPromptTextarea() {
    const textarea = document.getElementById('phrasing_prompt_textarea');
    if (!textarea) return;
    textarea.value = getActivePrompt();
}

function onEnabledChange(event) {
    settings.enabled = event.target.checked;
    debug('onEnabledChange — enabled:', settings.enabled);
    saveSettings();
    applyEnabledState();
    updateMessageActionButtons();
}

function onSaveToChat() {
    debug('onSaveToChat — triggered');
    const textarea = document.getElementById('phrasing_prompt_textarea');
    if (!textarea) return;

    const promptText = textarea.value.trim();
    debug('onSaveToChat — prompt length:', promptText.length, '| has {{phrasingSeed}}:', promptText.includes('{{phrasingSeed}}'));
    const context = getContext();

    // Validate: warn if {{phrasingSeed}} is missing.
    if (promptText && !promptText.includes('{{phrasingSeed}}')) {
        toast('Warning: Prompt does not contain {{phrasingSeed}}. The AI won\'t receive your input text.', 'warning');
    }

    // Save to chat metadata.
    if (!context.chatMetadata.phrasing) {
        context.chatMetadata.phrasing = {};
    }

    if (promptText) {
        context.chatMetadata.phrasing.prompt = promptText;
    } else {
        // Empty = use default.
        context.chatMetadata.phrasing.prompt = null;
    }

    context.saveMetadata();
    toast('Phrasing! prompt saved to chat.', 'success');
}

function onRestoreDefault() {
    debug('onRestoreDefault — triggered');
    if (!confirm('Restore the default Phrasing! prompt? This will overwrite your current prompt.')) {
        debug('onRestoreDefault — user cancelled');
        return;
    }

    const textarea = document.getElementById('phrasing_prompt_textarea');
    if (textarea) {
        textarea.value = DEFAULT_PHRASING_PROMPT;
    }

    // Clear the chat-level override.
    const context = getContext();
    if (context.chatMetadata.phrasing) {
        context.chatMetadata.phrasing.prompt = null;
    }
    context.saveMetadata();

    toast('Phrasing! prompt restored to default.', 'info');
}

// ── Event Handlers ─────────────────────────────────────────────────────────────

function onGenerationStarted() {
    debug('event: GENERATION_STARTED — hiding buttons');
    hideAllPhrasingButtons();
}

function onGenerationEnded() {
    debug('event: GENERATION_ENDED — phrasingActive:', phrasingActive);
    if (phrasingActive) {
        clearPhrasingInjection();
        phrasingActive = false;
        debug('event: GENERATION_ENDED — phrasingActive reset to false');
    }
    showAllPhrasingButtons();
}

function onGenerationStopped() {
    debug('event: GENERATION_STOPPED — phrasingActive:', phrasingActive);
    if (phrasingActive) {
        clearPhrasingInjection();
        phrasingActive = false;
        debug('event: GENERATION_STOPPED — phrasingActive reset to false');
    }
    showAllPhrasingButtons();
}

function onChatChanged() {
    debug('event: CHAT_CHANGED');
    loadPromptTextarea();
    // Defer to allow DOM to update.
    setTimeout(() => {
        updateMessageActionButtons();
        restoreUserSwipeControls();
    }, 100);
}

function onMessageRendered() {
    debug('event: MESSAGE_RENDERED');
    // Defer slightly to allow DOM to settle.
    setTimeout(() => {
        updateMessageActionButtons();
        restoreUserSwipeControls();
    }, 50);
}

// ── UI Creation ────────────────────────────────────────────────────────────────

function createInputAreaButton() {
    if (document.getElementById('phrasing_send_button')) {
        debug('createInputAreaButton — already exists, skipping');
        return;
    }

    const sendForm = document.getElementById('rightSendForm');
    if (!sendForm) {
        debug('createInputAreaButton — rightSendForm not found');
        return;
    }

    const btn = document.createElement('div');
    btn.id = 'phrasing_send_button';
    btn.classList.add('phrasing-trigger', 'fa-solid', 'fa-pen-fancy', 'interactable');
    btn.title = 'Phrasing! — Enrich your message with AI narration';
    btn.addEventListener('click', onInputPhrasingClick);

    sendForm.appendChild(btn);
    debug('createInputAreaButton — button created in rightSendForm');
}

function createHamburgerMenuItem() {
    if (document.getElementById('phrasing_menu_button')) {
        debug('createHamburgerMenuItem — already exists, skipping');
        return;
    }

    const impersonateBtn = document.getElementById('option_impersonate');
    if (!impersonateBtn) {
        debug('createHamburgerMenuItem — option_impersonate not found');
        return;
    }

    const btn = document.createElement('div');
    btn.id = 'phrasing_menu_button';
    btn.classList.add('phrasing-trigger', 'list-group-item', 'interactable');
    btn.innerHTML = '<span class="fa-solid fa-pen-fancy"></span> Phrasing!';
    btn.addEventListener('click', onInputPhrasingClick);

    impersonateBtn.parentNode.insertBefore(btn, impersonateBtn.nextSibling);
    debug('createHamburgerMenuItem — menu item created after option_impersonate');
}

// ── Slash Command ──────────────────────────────────────────────────────────────

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'phrasing',
        callback: async (_namedArgs, unnamedArgs) => {
            debug('slashCommand /phrasing — invoked, args:', unnamedArgs);
            if (!settings.enabled) {
                debug('slashCommand /phrasing — ABORTED: extension disabled');
                return '';
            }

            const seedText = unnamedArgs?.trim();

            if (seedText) {
                // With argument → Primary Flow.
                debug('slashCommand /phrasing — using Primary Flow with seed length:', seedText.length);
                return await doPrimaryFlow(seedText);
            } else {
                // Without argument → Swipe-Mode on last message.
                const context = getContext();
                const lastIndex = context.chat.length - 1;
                if (lastIndex < 0) {
                    debug('slashCommand /phrasing — ABORTED: no messages in chat');
                    toast('No messages to rephrase.', 'warning');
                    return '';
                }
                debug('slashCommand /phrasing — using Swipe-Mode on message index:', lastIndex);
                return await doSwipeMode(lastIndex);
            }
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Optional seed text to post and rephrase',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        aliases: [],
        helpString: 'Enriches a message with AI narration. With text: posts it and generates a rephrased swipe. Without text: rephrases the last message.',
    }));
}

// ── Initialization ─────────────────────────────────────────────────────────────

jQuery(async () => {
    // Load settings.
    loadSettings();

    // Load and inject the settings panel HTML.
    const settingsContainer = document.getElementById('extensions_settings');
    if (settingsContainer) {
        debug('init — injecting settings panel HTML');
        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${EXTENSION_NAME}`, 'settings', {});
        settingsContainer.insertAdjacentHTML('beforeend', settingsHtml);

        // Bind settings UI events.
        const enabledCheckbox = document.getElementById('phrasing_enabled');
        if (enabledCheckbox) {
            enabledCheckbox.checked = settings.enabled;
            enabledCheckbox.addEventListener('change', onEnabledChange);
        }

        const debugCheckbox = document.getElementById('phrasing_debug_mode');
        if (debugCheckbox) {
            debugCheckbox.checked = settings.debugMode;
            debugCheckbox.addEventListener('change', (event) => {
                settings.debugMode = event.target.checked;
                saveSettings();
                // Log unconditionally so the user sees the toggle take effect.
                console.log('PHRASING-DEBUG:', 'debugMode toggled to', settings.debugMode);
            });
        }

        document.getElementById('phrasing_save_to_chat')?.addEventListener('click', onSaveToChat);
        document.getElementById('phrasing_restore_default')?.addEventListener('click', onRestoreDefault);
    } else {
        debug('init — extensions_settings container not found');
    }

    // Create trigger buttons.
    createInputAreaButton();
    createHamburgerMenuItem();

    // Subscribe to events.
    debug('init — subscribing to ST events');
    const context = getContext();
    const { eventSource, eventTypes } = context;

    if (eventTypes.GENERATION_STARTED) {
        eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    }
    if (eventTypes.GENERATION_ENDED) {
        eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    }
    if (eventTypes.GENERATION_STOPPED) {
        eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    }
    if (eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    }
    if (eventTypes.USER_MESSAGE_RENDERED) {
        eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);
    }
    if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    }

    // Register slash command.
    registerSlashCommand();
    debug('init — slash command /phrasing registered');

    // Apply initial state.
    applyEnabledState();
    loadPromptTextarea();

    debug('init — Extension loaded, settings:', JSON.stringify(settings));
});
