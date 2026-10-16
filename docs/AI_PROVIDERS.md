# AI providers

Orbit is useful without paid AI. Set `AI_PROVIDER` to choose one explicit path; Orbit never silently switches providers.

| Value | Authentication | Best for |
| --- | --- | --- |
| `rules` | None | Maximum privacy, zero AI cost |
| `openai` | `OPENAI_API_KEY` | OpenAI Responses API |
| `anthropic` | `ANTHROPIC_API_KEY` | Claude API |
| `openai-compatible` | Base URL, model, optional key | Ollama, LM Studio, or another compatible server |

Consumer subscriptions and developer APIs are normally separate. A Claude Pro or Max subscription does not include Anthropic API usage.

## ChatGPT plan usage

OpenAI now provides **Sign in with ChatGPT** for eligible open-source tools. Eligible Plus and Pro users can authorize supported AI requests against their ChatGPT plan without sharing an API key or their conversations.

Orbit will support this as a separate `chatgpt-plan` provider. It must use the official OAuth + PKCE flow, validate tokens and scopes, stream Responses API calls with `store:false`, and keep rotating refresh tokens encrypted. We will not scrape ChatGPT cookies or accept account passwords.

For a remote self-host such as Railway, OpenAI's current flow requires completing authorization locally and securely transferring the protected registration to the VM. Until Orbit ships that companion flow, use `rules`, an API key, or an OpenAI-compatible local model.

## Local model example

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://host.docker.internal:11434/v1
AI_COMPATIBLE_MODEL=qwen3:8b
AI_COMPATIBLE_API_KEY=local
```

Local models are practical when Orbit runs on the same computer or network. A Railway container cannot reach Ollama running on a user's laptop without a secure tunnel.
