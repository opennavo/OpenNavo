## Fixes

- An expired Hermes Panel session stays signed out and asks you to sign in again. Results from that session cannot replace a later sign-in.
- The first message of a new Panel session retries if the profile is not ready yet. A saved SOUL.md is confirmed before you switch profiles, and a custom provider stays on its own row.
- Approval, question, sudo, secret, and vault cards stay with the request that opened them. Secrets are not copied into the conversation, and answering a card lets Hermes continue.
