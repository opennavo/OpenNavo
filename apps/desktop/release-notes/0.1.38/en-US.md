## New

- Paste text, links, file paths and images into the Hermes composer. Links and paths stay as reference chips, long pastes and clipboard images become attachments, and oversized pastes are rejected before anything is inserted.
- The Hermes model picker is now searchable, and local model discovery runs in a separate process, so browsing models no longer writes to the active profile or blocks the chat.

## Fixes

- A short network or wake-up failure no longer replaces the conversation with a sign-in screen. The cached transcript stays visible behind a reconnect banner, and retrying probes again immediately.
- The session switcher reloads its history when it opens or changes view, so sessions created by another client, a gateway or a scheduled job appear without restarting the app.
- The composer grows with a multi-line draft up to 110px, including while an IME composition is open, and collapses again when Send or New Chat clears it.
- A stopped turn now carries a clear "Turn stopped" badge, and interrupted replies stay empty, so the English UI no longer shows Chinese stop text.
- Sending while a reply is running follows the busy-input policy: the message is redirected, steered or queued instead of starting a second turn, and Stop stays available.
- Streaming and thinking updates no longer pull the transcript to the bottom while you are reading older messages. It follows the newest content only when you are already there.
- Hermes runtime installs, updates, and uninstalls now use one lifecycle slot: each install is staged separately, failed activation is rolled back, only processes launched by OpenNavo are cleaned up, and a gateway that cannot start fails fast instead of leaving the chat half-started.
- History stays consistent across clients and follows profile renames and deletions, panel and model state stay scoped to each window, and turn actions are bound to their own turn so a background turn cannot stop or resolve another conversation.
- A custom provider no longer silently falls back to built-in models when its catalog cannot be reached.
