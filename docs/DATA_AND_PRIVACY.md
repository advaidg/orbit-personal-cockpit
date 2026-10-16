# Data and privacy

Orbit is designed around data minimization.

## What is stored

- User identity: name, email, optional avatar.
- Connections: provider, account label, sync state, and encrypted OAuth credentials.
- Signals: source, title, short summary, category, priority, time, and small provider metadata.
- Tasks and their completion state.
- The latest generated brief.

## What is not stored

- Raw email bodies.
- ChatGPT or Claude conversations.
- AI prompts and responses as a historical log.
- Google, OpenAI, or Anthropic passwords.
- Browser cookies from another service.

During Gmail sync, message text exists in memory long enough to classify it. If an external AI provider is enabled, a bounded excerpt is sent to that provider. `AI_INPUT_CHARS_PER_ITEM` controls the maximum excerpt size. With `AI_PROVIDER=rules`, nothing is sent to an AI service.

## Retention

Normalized signals older than `SIGNAL_RETENTION_DAYS` are deleted automatically each day. The default is 30 days. Tasks remain until deleted so that user-created commitments are not silently lost.

## Personalization without hidden training

Orbit should learn through transparent, user-owned preferences:

- “Always surface messages from this person.”
- “Treat these receipts as weekly batch items.”
- “This sender is noise.”
- “Never send finance-related content to an external AI.”

These preferences should be stored as readable local rules. Orbit will not fine-tune a model on a user's mailbox or share feedback across installations without explicit opt-in.
