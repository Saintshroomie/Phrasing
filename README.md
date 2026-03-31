# Phrasing!

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that enriches your messages with AI-generated narration, prose, and detail — bridging the gap between what you type and what reads well in roleplay.

Type a simple message like *"Yes. I'm ok with that."*, click **Phrasing!**, and the AI rewrites it with narration, action, and sensory detail while preserving your original meaning. Your raw input is always kept as a swipe so you can go back to it.

## Features

- **One-click enrichment** — Type your message, click the Phrasing! button instead of Send, and get a polished version back as a new swipe
- **Message rephrase** — Click the Phrasing! icon on the last message to generate an alternative rephrased swipe
- **Swipe preservation** — Your original text is always kept as swipe 0; rephrased versions are added as new swipes you can navigate between
- **Customizable prompt** — Edit the rewriting instructions per-chat from the settings panel
- **Slash command** — Use `/phrasing` from the chat input for scripting and quick access
- **Group chat support** — Works in both solo and group chats
- **Impersonate fallback** — If the input field is empty, the hamburger menu button triggers Impersonate instead

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
2. Click the **Phrasing!** button (quill icon next to Send) or select **Phrasing!** from the hamburger menu
3. Your raw text is posted as a user message, then the AI generates an enriched version as a new swipe
4. Use the swipe arrows to switch between your original and the rephrased version

### Rephrasing an Existing Message

1. Click the **Phrasing!** icon (quill) on the last message's action bar (next to the swipe arrows)
2. A new swipe is generated with a rephrased version of the currently displayed text
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

1. Your raw input is posted as a normal user message (or the existing message is read)
2. The rewriting prompt (with your text substituted into `{{phrasingSeed}}`) is injected ephemerally at depth 0 as a System-role message
3. A guided swipe generation is triggered — the AI sees the full chat context plus the rewriting instruction
4. After generation completes, the injection is automatically removed
5. The result appears as a new swipe alongside your original text

The full prompt context (character card, lorebook, Author's Note, chat history) is preserved during generation, so the AI's rewrite is informed by the current scene and characters.

## License

This project is provided as-is for use with SillyTavern.
