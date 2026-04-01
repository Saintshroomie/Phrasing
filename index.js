import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    substituteParams,
    addOneMessage,
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
let phrasingActive = false; // true while a Phrasing!-triggered generation is running

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
 * Formats the seed text with the speaker's name prefix.
 * @param {string} seedText - The raw message text.
 * @param {boolean} isUser - Whether the speaker is the user.
 * @param {string} [speakerName] - Explicit speaker name (for group chats). Falls back to {{user}}/{{char}}.
 * @returns {string} Formatted as "Name: message".
 */
function formatSeedWithSpeaker(seedText, isUser, speakerName) {
    const context = getContext();
    let name;
    if (speakerName) {
        name = speakerName;
    } else if (isUser) {
        name = context.name1; // User name
    } else {
        name = context.name2; // Character name
    }
    debug('formatSeedWithSpeaker — speaker:', name, '| isUser:', isUser);
    return `${name}: ${seedText}`;
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

/**
 * Returns the name of a character that is actually present in the current
 * chat — needed because ST resolves the generating character from the message's
 * name field when processing swipes.
 *
 * For solo chats this is just context.name2. For group chats we walk back
 * through the chat history to find the most recent character who spoke,
 * which is always a valid group member. Falls back to context.name2.
 */
function getActiveCharacterName() {
    const context = getContext();
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (!msg.is_user && !msg.is_system && msg.name) {
            debug('getActiveCharacterName — found:', msg.name, 'at index', i);
            return msg.name;
        }
    }
    debug('getActiveCharacterName — fallback to context.name2:', context.name2);
    return context.name2;
}


/**
 * User Input Flow: Posts the user's seed text into the chat as a
 * character-flagged message (is_user: false) so ST renders it with swipe
 * buttons, then delegates to doSwipeMode to generate the rephrasing as a new
 * swipe. This allows successive rephrasing just like character messages.
 *
 * The message is stored with name set to the user's display name so
 * formatSeedWithSpeaker in doSwipeMode correctly attributes it.
 *
 * @param {string} rawSeedText - Raw, unformatted seed text from the textarea.
 */
async function doUserInputFlow(rawSeedText) {
    debug('doUserInputFlow — starting with seed length:', rawSeedText.length, '| preview:', rawSeedText.substring(0, 80));
    const context = getContext();

    if (context.isGenerating) {
        debug('doUserInputFlow — ABORTED: generation already in progress');
        return '';
    }

    // Build a character-flagged message object so ST renders it with swipe
    // buttons. is_user: false is intentional — user messages don't get swipe
    // controls in ST's DOM, which would prevent successive rephrasing.
    //
    // name must be a character that actually exists in the current chat —
    // ST validates this when processing swipes and will error otherwise.
    // We pass context.name1 as speakerOverride to doSwipeMode so the
    // injection still correctly attributes the text to the user.
    const charName = getActiveCharacterName();
    const message = {
        name: charName,
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: rawSeedText,
        swipes: [rawSeedText],
        swipe_id: 0,
        swipe_info: [{}],
        extra: {},
    };

    context.chat.push(message);
    const messageIndex = context.chat.length - 1;
    debug('doUserInputFlow — pushed message at index:', messageIndex, '| charName:', charName, '| speaker override:', context.name1);

    try {
        // Render the new message into the DOM and persist.
        await addOneMessage(message, { type: 'append', scroll: true });
        await context.saveChat();

        // Brief settle time to ensure swipe buttons are in the DOM before
        // doSwipeMode queries for them.
        await new Promise(resolve => setTimeout(resolve, 100));

        return await doSwipeMode(messageIndex, context.name1);
    } catch (err) {
        debug('doUserInputFlow — error before/during doSwipeMode:', err);
        showAllPhrasingButtons();
        throw err;
    }
}

/**
 * Swipe-Mode Flow (§2.3): Reads the currently displayed swipe of an existing
 * message and triggers a guided swipe with the Phrasing! prompt.
 * Returns the generated enriched text.
 *
 * @param {number} messageIndex
 * @param {string|null} speakerOverride - Name to use for injection attribution
 *   instead of message.name. Used by doUserInputFlow so the injection says
 *   "UserName: text" even though the message is stored under a character name.
 */
async function doSwipeMode(messageIndex, speakerOverride = null) {
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

    // Read the currently displayed swipe content as seed text.
    const rawSeedText = message.mes;
    if (!rawSeedText || !rawSeedText.trim()) {
        debug('doSwipeMode — ABORTED: message is empty');
        toast('Cannot rephrase an empty message.', 'warning');
        return '';
    }

    const seedText = formatSeedWithSpeaker(rawSeedText, message.is_user, speakerOverride || message.name);
    debug('doSwipeMode — seed text length:', seedText.length, '| is_user:', message.is_user, '| swipe_id:', message.swipe_id, '| speakerOverride:', speakerOverride);
    phrasingActive = true;
    debug('doSwipeMode — phrasingActive set to true');

    try {
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

        // Jump to the last swipe so a single swipe_right click triggers generation.
        // swipe_right only generates when already on the last swipe; otherwise it
        // just navigates. Instead of clicking through each intermediate swipe, we
        // set the data directly and re-render once.
        const lastSwipeIndex = message.swipes.length - 1;
        if (message.swipe_id !== lastSwipeIndex) {
            debug('doSwipeMode — jumping from swipe', message.swipe_id, 'to last swipe', lastSwipeIndex);
            message.swipe_id = lastSwipeIndex;
            message.mes = message.swipes[lastSwipeIndex];

            // Re-render the message to reflect the new active swipe.
            const messageEl = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
            if (messageEl) {
                const context = getContext();
                const textEl = messageEl.querySelector('.mes_text');
                if (textEl) {
                    if (typeof context.messageFormatting === 'function') {
                        textEl.innerHTML = context.messageFormatting(
                            message.mes, message.name, message.is_system, message.is_user, messageIndex,
                        );
                    } else {
                        textEl.textContent = message.mes;
                    }
                }
                // Update swipe counter display.
                const swipeCounter = messageEl.querySelector('.swipes-counter');
                if (swipeCounter) {
                    swipeCounter.textContent = `${message.swipe_id + 1}/${message.swipes.length}`;
                }
            }
        }

        // Now on the last swipe — one click triggers generation of a new swipe.
        const swipeRight = document.querySelector(`#chat .mes[mesid="${messageIndex}"] .swipe_right`);
        if (!swipeRight) {
            debug('doSwipeMode — FAILED: swipe_right button not found on message', messageIndex);
            return '';
        }

        debug('doSwipeMode — clicking swipe_right to generate new swipe');
        swipeRight.click();

        // Wait for generation to complete.
        debug('doSwipeMode — waiting for generation to complete');
        const result = await waitForGenerationEnd();
        debug('doSwipeMode — generation complete, result length:', result.length);
        return result;
    } finally {
        clearPhrasingInjection();
        phrasingActive = false;
        showAllPhrasingButtons();
        debug('doSwipeMode — cleanup complete (finally block)');
    }
}

/**
 * Returns a promise that resolves when the current generation ends.
 * Resolves with the last message's text (the generated swipe content).
 * Times out after 5 minutes to prevent hanging if events don't fire.
 */
function waitForGenerationEnd() {
    debug('waitForGenerationEnd — subscribing to GENERATION_ENDED/GENERATION_STOPPED');
    return new Promise(resolve => {
        const context = getContext();
        const { eventSource, eventTypes } = context;
        let settled = false;

        const cleanup = () => {
            eventSource.removeListener(eventTypes.GENERATION_ENDED, onEnd);
            eventSource.removeListener(eventTypes.GENERATION_STOPPED, onEnd);
        };

        const onEnd = () => {
            if (settled) return;
            settled = true;
            debug('waitForGenerationEnd — generation ended event received');
            cleanup();
            // Return the content of the currently active swipe of the last message.
            const ctx = getContext();
            const lastMsg = ctx.chat[ctx.chat.length - 1];
            debug('waitForGenerationEnd — last message length:', lastMsg ? lastMsg.mes.length : 0, '| swipe_id:', lastMsg?.swipe_id);
            resolve(lastMsg ? lastMsg.mes : '');
        };

        // Safety timeout — if neither event fires within 5 minutes, resolve
        // so the finally block in the caller can clean up the injection.
        setTimeout(() => {
            if (settled) return;
            settled = true;
            debug('waitForGenerationEnd — TIMED OUT after 5 minutes, forcing resolve');
            cleanup();
            resolve('');
        }, 5 * 60 * 1000);

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

    await doUserInputFlow(seedText);
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
    setTimeout(() => updateMessageActionButtons(), 100);
}

function onMessageRendered() {
    debug('event: MESSAGE_RENDERED');
    // Defer slightly to allow DOM to settle.
    setTimeout(() => updateMessageActionButtons(), 50);
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

            const rawSeedText = unnamedArgs?.trim();

            if (rawSeedText) {
                // With argument → post as character-flagged message and rephrase via swipe.
                debug('slashCommand /phrasing — using User Input Flow with seed length:', rawSeedText.length);
                return await doUserInputFlow(rawSeedText);
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
        helpString: 'Enriches a message with AI narration. With text: generates an enriched impersonate into the input field. Without text: rephrases the last message as a new swipe.',
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
