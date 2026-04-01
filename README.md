# Phrasing!

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that uses an existing message or user input as guidance for generations. If you're not a great write, or just feeling lazy, **Phrasing!** can be used to enrich your lame first draft message with AI-generated narration, prose, and detail — bridging the gap between what you type and what reads well in roleplay. If you really like an existing message, but want to try out different flavors without losing the gist, you can use **Phrasing!** to perform a guided regeneration of the message with the original message as the seed.

Type a simple message like *"Yes. I'm ok with that."*, click the quill, and you get a guided impersonate with narration, action, and sensory detail while preserving your original meaning. Clicking the quill in an existing character generated message will perform a guided swipe on the message, using the original message as the seed, giving you a variation that remains true to the source message.

## Features

- **One-click enrichment** — Type your message, click the Quill button instead of Send, and get a polished version back in the form of a guided Impersonate.
- **Message rephrase** — Click the Quill icon on the last message to generate an alternative rephrased swipe guided by the active swipe.
- **Swipe preservation** — Rephrased versions are added as new swipes you can navigate between
- **Customizable prompt** — Edit the rewriting instructions per-chat from the settings panel
- **Slash command** — Use `/phrasing` from the chat input for scripting and quick access
- **Group chat support** — Works in both solo and group chats

## Installation

1. Open SillyTavern and go to **Extensions** → **Install Extension**
2. Paste `https://github.com/Saintshroomie/Phrasing.git` and click **Install**
3. The extension will appear in your extensions list as **Phrasing!**

### Manual Installation

Clone this repository into your SillyTavern extensions directory:

```
SillyTavern/data/default-user/extensions/third-party/Phrasing
```

Refresh the SillyTavern page to load the extension.

## How to Use

### Enriching a New Message

1. Type your message in the chat input field
2. Click the quill button (next to Send) or select **Phrasing!** from the hamburger menu
3. Your raw text becomes the seed for a guided Impersonate generation.

### Rephrasing an Existing Message

1. Click the quill button on the last message
2. A new swipe is generated with a rephrased version of the currently active swipe
3. Swipe between variants to pick the one you like

### Slash Command

```
/phrasing I agree, let's go.
```

Posts the text as a user message and generates an enriched swipe. Without an argument, `/phrasing` rephrases the last message's current swipe.

## Settings

Open **Extensions** settings and expand the **Phrasing!** section:

| Setting | Description |
|---------|-------------|
| **Enable/Disable** | Master toggle — hides all Phrasing! buttons when off |
| **Prompt Template** | The rewriting instruction sent to the AI. Use `{{phrasingSeed}}` where the user's input should appear. Standard SillyTavern macros (`{{char}}`, `{{user}}`, etc.) are supported |
| **Restore Default Prompt** | Reset the prompt to the built-in default |
| **Save to Chat** | Save the current prompt to the active chat's metadata, allowing different prompts per chat |

### Default Prompt

```
[Rewrite the following message. Preserve its meaning, intent, and any dialogue,
but enrich it with narration, action, and detail consistent with the character
and the current scene. Do not continue the scene beyond what the original
message describes.

{{phrasingSeed}}]
```

## How It Works

Phrasing! uses SillyTavern's extension prompt injection system. When triggered:

1. Your raw input (or the existing message) is read in
2. The rewriting prompt (with your text substituted into `{{phrasingSeed}}`) is injected ephemerally at depth 0 as a System-role message
3. A guided swipe generation is triggered — the AI sees the full chat context plus the rewriting instruction
4. After generation completes, the injection is automatically removed
5. The result appears as an impersonation result in the text field or a new swipe of an existing message

The full prompt context (character card, lorebook, Author's Note, chat history) is preserved during generation, so the AI's rewrite is informed by the current scene and characters.
