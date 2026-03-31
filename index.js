import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    substituteParams,
} from '../../../../script.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const EXTENSION_NAME = 'Phrasing';
const INJECTION_KEY = 'phrasing_instruction';

const DEFAULT_PHRASING_PROMPT = `[Rewrite the following message. Preserve its meaning, intent, and any dialogue, but enrich it with narration, action, and detail consistent with the character and the current scene. Do not continue the scene beyond what the original message describes.

{{phrasingSeed}}]`;

const defaultSettings = {
    enabled: true,
};

// ── State ──────────────────────────────────────────────────────────────────────

let settings = { ...defaultSettings };
let phrasingActive = false; // true while a Phrasing!-triggered generation is running

// ── Helpers ────────────────────────────────────────────────────────────────────

function debug(...args) {
    console.log('PHRASING:', ...args);
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
    return chatPrompt || DEFAULT_PHRASING_PROMPT;
}

/**
 * Assembles the final prompt by replacing {{phrasingSeed}} and resolving ST macros.
 */
function assemblePrompt(seedText) {
    let prompt = getActivePrompt();
    prompt = prompt.replace(/\{\{phrasingSeed\}\}/g, seedText);
    prompt = substituteParams(prompt);
    return prompt;
}

/**
 * Injects the assembled Phrasing! prompt at depth 0, System role.
 */
function injectPhrasingPrompt(assembledPrompt) {
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
    setExtensionPrompt(INJECTION_KEY, '', extension_prompt_types.NONE, 0);
}

// ── Button Visibility ──────────────────────────────────────────────────────────

function hideAllPhrasingButtons() {
    document.querySelectorAll('.phrasing-trigger').forEach(el => {
        el.classList.add('phrasing-hidden');
    });
}

function showAllPhrasingButtons() {
    if (!settings.enabled) return;
    document.querySelectorAll('.phrasing-trigger').forEach(el => {
        el.classList.remove('phrasing-hidden');
    });
}

function applyEnabledState() {
    if (settings.enabled) {
        showAllPhrasingButtons();
    } else {
        hideAllPhrasingButtons();
    }
}

// ── Core Flows ─────────────────────────────────────────────────────────────────

/**
 * Primary Flow (§2.1): Posts seed text as a user message, then triggers a
 * guided swipe with the Phrasing! prompt injected.
 * Returns the generated enriched text.
 */
async function doPrimaryFlow(seedText) {
    const context = getContext();

    if (context.isGenerating) {
        debug('Generation already in progress, aborting primary flow');
        return '';
    }

    phrasingActive = true;

    // 1. Assemble and inject the prompt BEFORE sending the message
    //    so it's ready when the swipe generation fires.
    const assembled = assemblePrompt(seedText);
    injectPhrasingPrompt(assembled);

    // 2. Post the raw seed text as a real user message (becomes swipe 0).
    await context.executeSlashCommandsWithOptions(`/send ${seedText}`);

    // 3. Brief wait for the message to be fully added to the chat array and rendered.
    await new Promise(resolve => setTimeout(resolve, 300));

    // 4. Trigger a swipe-right on the last message to generate swipe 1.
    const lastMessageIndex = context.chat.length - 1;
    const messageEl = document.querySelector(`#chat .mes[mesid="${lastMessageIndex}"]`);
    if (messageEl) {
        const swipeRight = messageEl.querySelector('.swipe_right');
        if (swipeRight) {
            swipeRight.click();
        } else {
            debug('Could not find swipe_right button');
            clearPhrasingInjection();
            phrasingActive = false;
            return '';
        }
    } else {
        debug('Could not find last message element');
        clearPhrasingInjection();
        phrasingActive = false;
        return '';
    }

    // 5. Wait for generation to complete.
    const result = await waitForGenerationEnd();
    return result;
}

/**
 * Swipe-Mode Flow (§2.3): Reads the currently displayed swipe of an existing
 * message and triggers a guided swipe with the Phrasing! prompt.
 * Returns the generated enriched text.
 */
async function doSwipeMode(messageIndex) {
    const context = getContext();

    if (context.isGenerating) {
        debug('Generation already in progress, aborting swipe mode');
        return '';
    }

    const message = context.chat[messageIndex];
    if (!message) {
        debug('No message at index', messageIndex);
        return '';
    }

    // Read the currently displayed swipe content as seed text.
    const seedText = message.mes;
    if (!seedText || !seedText.trim()) {
        toast('Cannot rephrase an empty message.', 'warning');
        return '';
    }

    phrasingActive = true;

    // Ensure swipe array exists.
    if (!message.swipes || message.swipes.length === 0) {
        message.swipes = [message.mes];
        message.swipe_id = 0;
        message.swipe_info = [{}];
    }

    // Assemble and inject the prompt.
    const assembled = assemblePrompt(seedText);
    injectPhrasingPrompt(assembled);

    // Trigger a swipe-right on the target message.
    const messageEl = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageEl) {
        const swipeRight = messageEl.querySelector('.swipe_right');
        if (swipeRight) {
            swipeRight.click();
        } else {
            debug('Could not find swipe_right button');
            clearPhrasingInjection();
            phrasingActive = false;
            return '';
        }
    } else {
        debug('Could not find message element');
        clearPhrasingInjection();
        phrasingActive = false;
        return '';
    }

    // Wait for generation to complete.
    const result = await waitForGenerationEnd();
    return result;
}

/**
 * Returns a promise that resolves when the current generation ends.
 * Resolves with the last message's text (the generated swipe content).
 */
function waitForGenerationEnd() {
    return new Promise(resolve => {
        const context = getContext();
        const { eventSource, eventTypes } = context;

        const onEnd = () => {
            eventSource.removeListener(eventTypes.GENERATION_ENDED, onEnd);
            eventSource.removeListener(eventTypes.GENERATION_STOPPED, onEnd);
            // Return the content of the currently active swipe of the last message.
            const ctx = getContext();
            const lastMsg = ctx.chat[ctx.chat.length - 1];
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
    if (!settings.enabled) return;

    const context = getContext();
    if (context.isGenerating) return;

    const textarea = document.getElementById('send_textarea');
    const seedText = textarea?.value?.trim();

    if (!seedText) {
        // Empty input → Impersonate fallback
        const impersonateBtn = document.getElementById('option_impersonate');
        if (impersonateBtn) {
            impersonateBtn.click();
        }
        return;
    }

    // Clear the input field.
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    await doPrimaryFlow(seedText);
}

/**
 * Handler for the message action button.
 */
async function onMessagePhrasingClick(messageIndex) {
    if (!settings.enabled) return;

    const context = getContext();
    if (context.isGenerating) return;

    // Only allow on the last message.
    const lastIndex = context.chat.length - 1;
    if (messageIndex !== lastIndex) {
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
    if (!settings.enabled) return;

    const context = getContext();
    const lastIndex = context.chat.length - 1;

    // Remove existing phrasing buttons from all messages.
    document.querySelectorAll('.phrasing_mes_button').forEach(el => el.remove());

    if (lastIndex < 0) return;

    const lastMessageEl = document.querySelector(`#chat .mes[mesid="${lastIndex}"]`);
    if (!lastMessageEl) return;

    // Find the extra mes buttons area (where swipe buttons and other actions live).
    const extraButtons = lastMessageEl.querySelector('.extraMesButtons, .mes_buttons');
    if (!extraButtons) return;

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
}

// ── Settings Management ────────────────────────────────────────────────────────

function loadSettings() {
    const context = getContext();
    const saved = context.extensionSettings?.phrasing;
    if (saved) {
        settings = { ...defaultSettings, ...saved };
    }
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings.phrasing = { ...settings };
    context.saveSettings();
}

function loadPromptTextarea() {
    const textarea = document.getElementById('phrasing_prompt_textarea');
    if (!textarea) return;
    textarea.value = getActivePrompt();
}

function onEnabledChange(event) {
    settings.enabled = event.target.checked;
    saveSettings();
    applyEnabledState();
    updateMessageActionButtons();
}

function onSaveToChat() {
    const textarea = document.getElementById('phrasing_prompt_textarea');
    if (!textarea) return;

    const promptText = textarea.value.trim();
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
    if (!confirm('Restore the default Phrasing! prompt? This will overwrite your current prompt.')) {
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
    hideAllPhrasingButtons();
}

function onGenerationEnded() {
    if (phrasingActive) {
        clearPhrasingInjection();
        phrasingActive = false;
    }
    showAllPhrasingButtons();
}

function onGenerationStopped() {
    if (phrasingActive) {
        clearPhrasingInjection();
        phrasingActive = false;
    }
    showAllPhrasingButtons();
}

function onChatChanged() {
    loadPromptTextarea();
    // Defer to allow DOM to update.
    setTimeout(() => updateMessageActionButtons(), 100);
}

function onMessageRendered() {
    // Defer slightly to allow DOM to settle.
    setTimeout(() => updateMessageActionButtons(), 50);
}

// ── UI Creation ────────────────────────────────────────────────────────────────

function createInputAreaButton() {
    if (document.getElementById('phrasing_send_button')) return;

    const sendForm = document.getElementById('rightSendForm');
    if (!sendForm) return;

    const btn = document.createElement('div');
    btn.id = 'phrasing_send_button';
    btn.classList.add('phrasing-trigger', 'fa-solid', 'fa-pen-fancy', 'interactable');
    btn.title = 'Phrasing! — Enrich your message with AI narration';
    btn.addEventListener('click', onInputPhrasingClick);

    sendForm.appendChild(btn);
}

function createHamburgerMenuItem() {
    if (document.getElementById('phrasing_menu_button')) return;

    const impersonateBtn = document.getElementById('option_impersonate');
    if (!impersonateBtn) return;

    const btn = document.createElement('div');
    btn.id = 'phrasing_menu_button';
    btn.classList.add('phrasing-trigger', 'list-group-item', 'interactable');
    btn.innerHTML = '<span class="fa-solid fa-pen-fancy"></span> Phrasing!';
    btn.addEventListener('click', onInputPhrasingClick);

    impersonateBtn.parentNode.insertBefore(btn, impersonateBtn.nextSibling);
}

// ── Slash Command ──────────────────────────────────────────────────────────────

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'phrasing',
        callback: async (_namedArgs, unnamedArgs) => {
            if (!settings.enabled) {
                return '';
            }

            const seedText = unnamedArgs?.trim();

            if (seedText) {
                // With argument → Primary Flow.
                return await doPrimaryFlow(seedText);
            } else {
                // Without argument → Swipe-Mode on last message.
                const context = getContext();
                const lastIndex = context.chat.length - 1;
                if (lastIndex < 0) {
                    toast('No messages to rephrase.', 'warning');
                    return '';
                }
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
        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${EXTENSION_NAME}`, 'settings', {});
        settingsContainer.insertAdjacentHTML('beforeend', settingsHtml);

        // Bind settings UI events.
        const enabledCheckbox = document.getElementById('phrasing_enabled');
        if (enabledCheckbox) {
            enabledCheckbox.checked = settings.enabled;
            enabledCheckbox.addEventListener('change', onEnabledChange);
        }

        document.getElementById('phrasing_save_to_chat')?.addEventListener('click', onSaveToChat);
        document.getElementById('phrasing_restore_default')?.addEventListener('click', onRestoreDefault);
    }

    // Create trigger buttons.
    createInputAreaButton();
    createHamburgerMenuItem();

    // Subscribe to events.
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

    // Apply initial state.
    applyEnabledState();
    loadPromptTextarea();

    debug('Extension loaded');
});
