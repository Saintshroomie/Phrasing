# Phrasing! — SillyTavern Extension Design Document

> **Version:** 1.0  
> **Author:** Chris Phifer  
> **Status:** Draft  
> **Backend Assumption:** KoboldCPP (Text Completion API)

---

## 1. Overview

**Phrasing!** is a SillyTavern extension that enriches user-authored messages using the active LLM. Instead of submitting raw input directly to the chat, the user invokes Phrasing! to have the AI rewrite their input with added narration, internal monologue, sensory detail, and prose styling — while preserving the original intent and meaning.

The extension targets users who want richer, more immersive roleplay contributions but may not have the time, confidence, or skill to write elaborate prose themselves. It bridges the gap between "what the user means" and "what reads well in the scene."

---

## 2. Core Workflow

### 2.1 Primary Flow (Input Field → Impersonate)

1. User types raw input into the ST chat input field (e.g., *"Yes. I'm ok with that."*).
2. User clicks the **Phrasing!** button (instead of the normal Send button).
3. The extension:
   a. Captures and clears the input field text (the **seed text**).
   b. Injects the Phrasing! prompt (containing the seed text and rewriting instructions) into the prompt at depth 0, ephemerally.
   c. Triggers an **Impersonate** action. The AI generates enriched prose guided by the injected prompt, as if writing from the user's persona.
   d. The generated enriched text lands in the **input field** (`#send_textarea`) for the user to review, edit, and send.
   e. After generation completes, the ephemeral injection is removed.
4. The result is the AI-enriched prose sitting in the input field, ready for the user to review before sending. The user can edit the text, send it as-is, or discard it.

> **Why Impersonate instead of swipes?** SillyTavern does not support swipe generation on user messages — swipes are a character/AI message feature. Impersonate naturally generates text from the user's perspective, and placing the result in the input field gives the user a chance to review before committing.

### 2.2 Empty Input Fallback

If the input field is empty when the user clicks any Phrasing! trigger button (input-area buttons only — not the message action button), the extension performs a standard **Impersonate** action by programmatically clicking the existing Impersonate button. No special handling is needed.

### 2.3 Swipe-Mode Flow (Message Action → Existing Message)

1. User clicks the **Phrasing!** button in the message action area (beside swipe arrows) on the last message in the chat.
2. The extension:
   a. Reads the **currently displayed swipe** as the seed text. If the message has multiple swipes, the seed is whichever swipe the user is viewing when they press the button — not necessarily swipe 0.
   b. If the message does not already have swipes, initializes the swipe array with the current content as swipe 0.
   c. Injects the Phrasing! prompt with the seed text at depth 0, ephemerally.
   d. Triggers a **guided swipe** on the message. ST's native swipe generation handles the placeholder ellipsis, streaming, and swipe array management.
   e. The generated rephrasing lands as a **new swipe**. ST automatically navigates to it.
   f. The ephemeral injection is removed after generation.
3. The user can swipe between the original message, any previous swipes, and any number of Phrasing! variants, keeping whichever they prefer.

---

## 3. Trigger Buttons

Phrasing! is accessible from three distinct UI locations, each with slightly different behavior depending on context.

### 3.1 Button: Input Area (Primary)

- **Location:** Next to the Send button, beside the chat input field.
- **Appearance:** A distinct button with the Phrasing! icon/label, visually differentiated from Send.
- **Seed text source:** Input field contents.
- **Empty input behavior:** Falls back to Impersonate.
- **Flow:** Primary Flow (§2.1).

### 3.2 Button: Hamburger Menu

- **Location:** Inside the hamburger/options menu beside the chat input field (where other action buttons like Continue, Impersonate, etc. live).
- **Appearance:** Menu item with Phrasing! label/icon, consistent with existing menu item styling.
- **Seed text source:** Input field contents.
- **Empty input behavior:** Falls back to Impersonate.
- **Flow:** Primary Flow (§2.1).

### 3.3 Button: Message Actions (Swipe-Mode)

- **Location:** In the message action button area, near the swipe navigation arrows.
- **Visibility:** Only shown on the **last message** in the chat, regardless of whether it is a user message or a character message. This mirrors the swipe controls' own visibility — only the last message supports swipe generation in SillyTavern. The prompt is character-agnostic, so rephrasing works on any message.
- **Appearance:** Compact button/icon consistent with existing message action buttons.
- **Seed text source:** The **currently displayed swipe** of the message. If the message has multiple swipes, the seed is whichever swipe the user is viewing when they press the button.
- **Empty input behavior:** N/A — the message content is always the seed. If the active swipe is somehow empty, do nothing (no-op with a toast notification).
- **Flow:** Swipe-Mode Flow (§2.3).

---

## 4. Prompt System

### 4.1 Default Prompt Template

The extension ships with a default prompt that instructs the AI to rewrite a message as enriched roleplay prose. The prompt is character-agnostic — it does not reference `{{user}}` or `{{char}}`, so it works whether the message being rephrased belongs to the user's persona or any other character.

The prompt uses a `{{phrasingSeed}}` placeholder that the extension replaces with the seed text at runtime.

**Default Prompt:**

```
[Rewrite the following message. Preserve its meaning, intent, and any dialogue, but enrich it with narration, action, and detail consistent with the character and the current scene. Do not continue the scene beyond what the original message describes.

{{phrasingSeed}}]
```

### 4.2 Prompt Placeholder

- `{{phrasingSeed}}` — Replaced at runtime with the seed text. This is a custom macro local to the Phrasing! extension, not a native ST macro.
- The seed text is the raw message content as it appears in the chat, including any character name prefix (e.g., the message content itself — the extension does not add or strip name prefixes).
- Native ST macros (`{{user}}`, `{{char}}`, `{{group}}`, etc.) are supported in the prompt template if the user adds them to a custom prompt. They are resolved normally by ST at generation time.

### 4.3 Prompt Injection Method

The Phrasing! prompt is injected **ephemerally** into the generation context. It is not permanently stored in chat history or visible as a message.

**Mechanism:**

- Use SillyTavern's extension injection API (or `/inject` equivalent) to place the assembled prompt at **depth 0** with **System role** immediately before triggering the guided swipe.
- The injection is scoped to a single generation and removed after the generation completes (or on abort).
- This ensures the AI sees the rewriting instruction as the highest-priority directive for this specific generation, without polluting the ongoing chat context.

### 4.4 Context Preservation

Phrasing! does **not** operate in isolation. The generation request includes the full normal prompt context:

- System prompt / Main prompt
- Character card (description, personality, scenario)
- World Info / Lorebook entries (triggered normally by keyword scan)
- Chat history
- Author's Note, Character's Note, Persona Description
- Post-History Instructions

The only addition is the ephemeral Phrasing! injection at depth 0. This means the AI has full scene awareness when rewriting the user's input — it knows the characters, the setting, the recent events, and the tone.

---

## 5. Settings Panel

### 5.1 Location

The Phrasing! settings panel is accessible from the **Extensions** settings area in SillyTavern, under a "Phrasing!" section header.

### 5.2 Settings UI Elements

| Element | Type | Description |
|---------|------|-------------|
| **Enable/Disable Toggle** | Checkbox | Master toggle for the extension. When disabled, all Phrasing! buttons are hidden. |
| **Prompt Template** | Textarea | Editable text area displaying the current active prompt. The user can modify this freely. Must contain `{{phrasingSeed}}` somewhere in the text to function. |
| **Restore Default Prompt** | Button | Resets the prompt textarea to the built-in default (§4.1). Requires confirmation before overwriting user edits. |
| **Save to Chat** | Button | Explicitly saves the current prompt text to the active chat's metadata. Visual feedback (toast/flash) on save. |

### 5.3 Prompt Persistence & Chat Binding

The active Phrasing! prompt is stored in the **chat metadata** so that different chats can use different prompts. The storage hierarchy:

1. **Chat-level prompt** (highest priority) — Stored in `chat_metadata.phrasing_prompt`. If present, this is used.
2. **Extension-level default** — The built-in default prompt (§4.1). Used when no chat-level prompt exists.

**Behavior:**

- When the user opens a chat that has a saved Phrasing! prompt in its metadata, the settings textarea loads that prompt.
- When the user opens a chat with no saved prompt, the settings textarea loads the extension default.
- Editing the textarea and clicking "Save to Chat" writes to the current chat's metadata.
- "Restore Default Prompt" replaces the textarea content with the built-in default AND saves it to the chat metadata (clearing the override).
- Switching chats reloads the textarea from the new chat's metadata (or falls back to default).

### 5.4 Validation

- If the user saves a prompt that does not contain `{{phrasingSeed}}`, display a warning toast: *"Warning: Prompt does not contain {{phrasingSeed}}. The AI won't receive your input text."* Allow the save but make the issue visible.
- Empty prompt textarea: Treat as "use default" — functionally equivalent to restoring the default.

---

## 6. Data Flow Diagrams

### 6.1 Primary Flow (Input → Impersonate)

```
User types input ──► Clicks Phrasing! button
                            │
                            ▼
                 ┌─ Capture input text (seed)
                 ├─ Clear input field
                 ├─ Load prompt template (chat metadata → default fallback)
                 ├─ Replace {{phrasingSeed}} with seed text
                 ├─ Resolve ST macros ({{user}}, {{char}}, etc.)
                 ├─ Inject assembled prompt at depth 0, System role
                 ├─ Trigger Impersonate action
                 │       │
                 │       ▼
                 │   AI generates enriched prose as user persona
                 │   (guided by injected Phrasing! prompt)
                 │       │
                 │       ▼
                 ├─ Generation complete → enriched text lands in #send_textarea
                 ├─ Remove ephemeral injection
                 └─ User reviews, edits, and sends the enriched text
```

### 6.2 Swipe-Mode Flow (Message Action)

```
User clicks Phrasing! on last message in chat
                            │
                            ▼
                 ┌─ Read currently displayed swipe content (seed)
                 ├─ Ensure swipe array exists (init with current content as swipe 0 if needed)
                 ├─ Load prompt template (chat metadata → default fallback)
                 ├─ Replace {{phrasingSeed}} with seed text
                 ├─ Resolve ST macros
                 ├─ Inject assembled prompt at depth 0, System role
                 ├─ Trigger guided swipe on the message
                 │       │
                 │       ▼
                 │   ST native swipe UI: ellipsis → streaming tokens
                 │       │
                 │       ▼
                 ├─ Generation complete (new swipe added)
                 ├─ Remove ephemeral injection
                 └─ User can swipe between all versions
```

---

## 7. Edge Cases & Error Handling

### 7.1 Generation Abort

If the user aborts generation mid-stream (e.g., clicks Stop):

- Whatever has been generated so far is kept as the message content (or swipe content).
- The ephemeral injection is removed.
- The raw seed text remains preserved in the swipe array.

### 7.2 Generation Failure

If the generation call fails (backend error, timeout, connection loss):

- In Primary Flow: The input field may be empty or contain partial output. The user's original seed text has already been cleared from the input field, but since no message was posted, the chat state is unchanged. A toast notification indicates the failure.
- In Swipe-Mode: No new swipe is added. A toast notification indicates the failure. The original message is untouched.
- The ephemeral injection is removed in all cases.

### 7.3 Group Chats

In group chats, Phrasing! works naturally:

- The Primary Flow and Hamburger Menu buttons work identically to solo chat — they enrich the user's input from the input field.
- The Message Action button appears on the **last message** regardless of who authored it — user or any character. This is especially useful in group chats where the user may want to rephrase a character's reply for better quality.
- Since the prompt is character-agnostic (no `{{user}}`/`{{char}}` references), it works regardless of which persona or character the message belongs to.

### 7.4 Concurrent Generation

If a generation is already in progress (either a normal AI response or another Phrasing! call), all three Phrasing! buttons are **hidden** (not just disabled — completely removed from the UI) until the current generation completes. This prevents conflicting injection states and reduces visual clutter during generation. Buttons reappear when generation finishes or is aborted.

### 7.5 Very Long Seed Text

If the user's seed text is unusually long (approaching or exceeding what the prompt template + seed can fit in the injection), no special truncation is performed — the normal ST context budget handling applies. The injection competes for context space like any other prompt component. If it's too large, the user will see degraded output and can shorten their input.

---

## 8. Technical Implementation Notes

### 8.1 Extension Structure

```
SillyTavern/public/scripts/extensions/third-party/Phrasing/
├── manifest.json          # Extension metadata
├── index.js               # Main extension logic
├── style.css              # Button and panel styling
├── settings.html          # Settings panel template (injected into Extensions UI)
└── README.md              # User-facing documentation
```

### 8.2 Key ST APIs / Integration Points

| Need | ST API / Mechanism |
|------|--------------------|
| Chat input field access | `#send_textarea` element |
| Send button adjacency | Insert button beside `#send_but` |
| Hamburger menu insertion | Append to the options menu container |
| Message action buttons | Hook into message rendering to add per-message buttons |
| Post user message | `sendMessageAsUser()` or equivalent chat API |
| Swipe management | Access `chat[messageIndex].swipes` array; use ST swipe navigation APIs |
| Ephemeral prompt injection | `setExtensionPrompt()` with `extension_prompt_types.IN_CHAT` at depth 0, removed after generation |
| Trigger guided swipe | Programmatically trigger a swipe generation on a user message (e.g., simulate swipe-right or call the underlying swipe generation function) |
| Trigger Impersonate | Programmatically click `#option_impersonate` |
| Chat metadata | `getContext().chatMetadata` for per-chat prompt storage |
| Settings persistence | `extension_settings.phrasing` for extension-level defaults |
| Generation state detection | Listen for generation start/end events to manage button enabled/disabled state |
| Toast notifications | ST's `toastr` for user feedback |

### 8.3 Injection Lifecycle

```
1. setExtensionPrompt('phrasing_instruction', assembledPrompt, extension_prompt_types.IN_CHAT, 0, 0, true)
   ├─ name: 'phrasing_instruction'
   ├─ value: the fully assembled prompt with seed text inserted
   ├─ type: IN_CHAT (injected into chat history at depth)
   ├─ position: 0 (depth 0 — after the last message)
   ├─ depth: 0
   └─ role: 0 (System)

2. Trigger generation (Impersonate for Primary Flow, Swipe for Swipe-Mode)

3. On generation complete (or abort/error):
   setExtensionPrompt('phrasing_instruction', '', extension_prompt_types.IN_CHAT, 0)
   └─ Clears the injection
```

### 8.4 Swipe Array Management

**Primary Flow — Impersonate:**

The Primary Flow no longer uses swipes. Instead, the seed text is embedded in the injected prompt, and an Impersonate action generates the enriched text directly into `#send_textarea`. No swipe array management is needed for this flow.

**Swipe-Mode — existing message:**

```javascript
const message = chat[messageIndex];

// Ensure swipe array exists
if (!message.swipes || message.swipes.length === 0) {
    message.swipes = [message.mes];
    message.swipe_id = 0;
    message.swipe_info = [{}];
}

// Trigger a guided swipe — ST's native swipe generation handles:
//   1. Adding the new swipe slot
//   2. Placeholder display
//   3. Streaming and navigation
// The extension only needs to inject the prompt before triggering the swipe.
```

### 8.5 Chat Metadata Schema

```javascript
// Stored in chat_metadata.phrasing
{
    "prompt": "string | null"   // Custom prompt for this chat. null = use extension default.
}
```

Access pattern:

```javascript
const context = getContext();
const chatPrompt = context.chatMetadata?.phrasing?.prompt;
const activePrompt = chatPrompt || DEFAULT_PHRASING_PROMPT;
```

---

## 9. UI/UX Specifications

### 9.1 Button Appearance

- **Primary Button (Input Area):** Compact, icon-based button matching ST's existing input area button styling. Tooltip: "Phrasing! — Enrich your message with AI narration". Consider using a pen/quill icon or a speech bubble with sparkle.
- **Hamburger Menu Item:** Text label "Phrasing!" with the same icon, styled consistently with other menu items (Impersonate, Continue, etc.).
- **Message Action Button:** Small icon button matching the size and style of swipe arrows and other message action buttons. Tooltip: "Phrasing! — Add a rephrased swipe". Only visible on user messages.

### 9.2 Visual Feedback During Generation

- **Swipe generation:** Handled entirely by ST's native swipe UI — placeholder ellipsis, streaming tokens, and final render are all standard swipe behavior. No custom visual logic needed.
- **Completion:** The new swipe finishes rendering and is displayed, same as any other swipe generation.

### 9.3 Button Visibility During Generation

During any active generation (Phrasing! or otherwise), all three Phrasing! buttons are **hidden completely** — not dimmed or grayed out, but removed from the DOM (or set to `display: none`). They reappear when generation completes or is aborted.

### 9.4 Settings Panel Layout

```
┌──────────────────────────────────────────────┐
│ Phrasing!                              [ON] │
├──────────────────────────────────────────────┤
│                                              │
│ Prompt Template:                             │
│ ┌──────────────────────────────────────────┐ │
│ │ [Rewrite the following message.          │ │
│ │ Preserve its meaning, intent, and any    │ │
│ │ dialogue, but enrich it with narration,  │ │
│ │ action, and detail consistent with the   │ │
│ │ character and the current scene. Do not  │ │
│ │ continue the scene beyond what the       │ │
│ │ original message describes.              │ │
│ │                                          │ │
│ │ {{phrasingSeed}}]                        │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [Restore Default Prompt]    [Save to Chat]   │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 10. Slash Command

Phrasing! exposes a `/phrasing` STscript command for scripting and automation workflows.

### 10.1 Syntax

```
/phrasing [optional seed text]
```

### 10.2 Behavior

- **With argument** (`/phrasing I agree, let's go.`): Posts the argument text as a user message, injects the Phrasing! prompt, and triggers a guided swipe — identical to the Primary Flow (§2.1). The argument becomes swipe 0, and the enriched version becomes swipe 1.
- **Without argument** (`/phrasing`): Operates on the last message in the chat (regardless of author), using the currently displayed swipe as the seed text — identical to the Swipe-Mode Flow (§2.3). If no messages exist, no-op.
- **Prompt source:** Uses the active chat's Phrasing! prompt (chat metadata → extension default fallback), same as the button triggers.
- **Return value:** The generated enriched text, enabling piping into other STscript commands (e.g., `/phrasing I nod slowly. | /echo`).

### 10.3 Integration Notes

- The slash command respects the extension's enable/disable toggle — if Phrasing! is disabled, `/phrasing` does nothing and returns an empty string.
- Generation is asynchronous; the command waits for completion before returning.
- Abort behavior matches §7.1 — partial output is kept.

---

## 11. Summary

| Aspect | Detail |
|--------|--------|
| **Extension Name** | Phrasing! |
| **Purpose** | Enrich user roleplay messages with AI-generated narration, prose, and detail |
| **Generation Method** | Primary: ephemeral prompt injection at depth 0 → Impersonate (result in textarea). Swipe-Mode: ephemeral injection → guided swipe on existing message |
| **Seed Text** | Input field (primary/hamburger buttons) or existing message content (message action button) |
| **Empty Input** | Falls back to Impersonate |
| **Swipe Integration** | Primary: enriched text placed in input field for review. Swipe-Mode: enriched text as new swipe on existing message |
| **Prompt Storage** | Per-chat via chat metadata, with extension-level default fallback |
| **Trigger Locations** | Input area button, hamburger menu item, message action button (last message only), `/phrasing` slash command |
| **Backend** | KoboldCPP (Text Completion); inherits current sampler/generation settings |
| **Context** | Full normal prompt context (char card, lorebook, chat history, Author's Note, etc.) + ephemeral Phrasing! injection |
