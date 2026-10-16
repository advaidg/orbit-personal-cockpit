# Orbit product vision

## The promise

Orbit answers one question: **What deserves my attention now?**

It is not another inbox, task manager, or analytics dashboard. It is a private operations layer that watches the tools a person already uses, remembers commitments, detects changes, and presents a small number of decisions.

## The six surfaces

### 1. Today

An AI brief, the next three actions, schedule risks, and meaningful changes since the last visit.

### 2. Waiting on

Promises made by other people, expected replies, delegated work, and suggested follow-up dates. This is the feature most ordinary task managers miss.

### 3. Timeline

A provider-neutral history showing when a commitment appeared, changed, became urgent, or was resolved.

### 4. People

Relationship memory assembled from user-approved sources: last meaningful contact, open loops, promised introductions, and important dates—without turning people into sales leads.

### 5. Life admin

Bills, renewals, travel changes, deliveries, expiring documents, appointments, and recurring costs. Orbit should prevent expensive surprises.

### 6. Ask Orbit

Questions grounded only in the user's connected information: “What am I waiting on?”, “What changed while I was away?”, and “What should I prepare before tomorrow?”

## Connector roadmap

| Phase | Connectors | Outcome |
| --- | --- | --- |
| Foundation | Multiple Gmail accounts, manual tasks | One brief across personal and work email |
| Time | Google Calendar, Outlook Calendar | Conflicts, preparation, travel buffers |
| Work | GitHub, Slack, Linear | Reviews, blockers, decisions, commitments |
| Life | Outlook Mail, receipt and travel parsing | Bills, renewals, reservations, changes |
| Context | Drive, Notion | Bring the right document into each decision |

## Features worth building

- **Commitment graph:** detect “I’ll send this Friday” and track both sides of the promise.
- **Change detection:** explain what changed, not merely what arrived.
- **Focus contracts:** let users declare a priority and suppress unrelated signals temporarily.
- **Decision packets:** gather the relevant thread, document, options, and deadline into one card.
- **Personal rules:** plain-language policies such as “always surface school email” or “batch receipts weekly.”
- **Replayable AI:** every recommendation shows its sources and can be regenerated after correcting a classification.
- **Local-first export:** JSON/Markdown export and full deletion should be first-class features.

## Product guardrails

- Never measure success by time spent in Orbit.
- Never manufacture urgency to increase engagement.
- Never send, delete, purchase, or schedule without explicit confirmation.
- Show why an item was prioritized and where it came from.
- A useful non-AI mode is required, not optional.
