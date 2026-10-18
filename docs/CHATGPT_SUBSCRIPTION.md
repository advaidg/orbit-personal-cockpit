# Use a ChatGPT plan with Orbit

Orbit supports OpenAI's Sign in with ChatGPT token-sharing preview for eligible open-source tools. This is distinct from an OpenAI API key. Availability, eligible plans, limits, and supported models are controlled by OpenAI and may change during the preview.

## Connect (about a minute, no command line)

1. In Orbit open **Connections → Set up Orbit → Intelligence → ChatGPT plan** and press **Sign in with ChatGPT**.
2. OpenAI opens in a new tab. Sign in and approve access.
3. Your browser then shows *“This site can’t be reached”* at an address starting with `http://127.0.0.1`. **That is expected.** Copy the whole address from the address bar.
4. Paste it into Orbit. Orbit finishes the sign-in on the server, checks the identity with OpenAI, and stores the credentials encrypted.
5. Pick one of the models returned for your account and press **Use ChatGPT plan**.

**If Orbit runs on your own computer** (`APP_URL` is `http://localhost:…`), step 3 disappears: OpenAI sends your browser straight back to Orbit, which finishes the sign-in by itself and shows “ChatGPT connected”. OpenAI only accepts a `127.0.0.1` return address, which is why a cloud-hosted Orbit needs the paste step: nothing is listening on `127.0.0.1` in your browser’s computer except Orbit when it runs there.

The address you paste carries a one-time code. Orbit only accepts one that matches the sign-in it started (same state value, same loopback address), uses the code once, and keeps the PKCE secret on the server. Each installation has a stable random host ID, so credentials for one installation cannot be used by another.

**Fallback:** if you cannot paste an address (for example on a locked-down phone), the same panel offers the older helper, which runs one command on your own computer and uploads a credentials file. See `scripts/chatgpt-connect.ts`.

## Data and limitations

- Orbit sends bounded message excerpts, normalized signals, tasks, and prompts only when needed for classification, briefs, or Ask Orbit.
- Requests use `store:false` and consume the response stream through completion.
- Orbit cannot access your ChatGPT conversations, memory, custom instructions, or password.
- Access tokens are refreshed server-side and rotating refresh tokens are re-encrypted after refresh.
- Disconnect attempts to revoke the refresh token and always deletes the stored local credentials.
- The feature is an OpenAI preview. Unsupported endpoints and features are intentionally not emulated.

Official references: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
