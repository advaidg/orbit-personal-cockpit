# AI providers

Orbit is useful without paid AI. Set `AI_PROVIDER` to choose one explicit path; Orbit never silently switches providers.

| Value | Authentication | Best for |
| --- | --- | --- |
| `rules` | None | Maximum privacy, zero AI cost |
| `chatgpt-subscription` | Sign in with ChatGPT | Eligible ChatGPT plan usage (preview) |
| `openai` | `OPENAI_API_KEY` | OpenAI Responses API |
| `anthropic` | `ANTHROPIC_API_KEY` | Claude API |
| `openai-compatible` | Base URL, model, optional key | Ollama, LM Studio, or another compatible server |

Consumer subscriptions and developer APIs are normally separate. A Claude Pro or Max subscription does not include Anthropic API usage.

## ChatGPT plan usage

OpenAI now provides **Sign in with ChatGPT** for eligible open-source tools. Eligible Plus and Pro users can authorize supported AI requests against their ChatGPT plan without sharing an API key or their conversations.

Orbit supports this as the separate `chatgpt-subscription` provider. It uses the official OAuth + PKCE flow, validates identity tokens and scopes, streams Responses API calls with `store:false`, and keeps rotating refresh tokens encrypted. Orbit does not scrape ChatGPT cookies, accept account passwords, or read ChatGPT conversations or memory.

For a remote self-host such as Railway, authorization is completed locally and the protected credential bundle is imported into the owner-only Settings screen. See [ChatGPT plan setup](CHATGPT_SUBSCRIPTION.md).

## Local model example

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://host.docker.internal:11434/v1
AI_COMPATIBLE_MODEL=qwen3:8b
AI_COMPATIBLE_API_KEY=local
```

Local models are practical when Orbit runs on the same computer or network. A Railway container cannot reach Ollama running on a user's laptop without a secure tunnel.
