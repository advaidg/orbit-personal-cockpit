# Use a ChatGPT plan with Orbit

Orbit supports OpenAI's Sign in with ChatGPT token-sharing preview for eligible open-source tools. This is distinct from an OpenAI API key. Availability, eligible plans, limits, and supported models are controlled by OpenAI and may change during the preview.

## Connect a Railway installation

1. Sign in to Orbit, open **Connections → Set up Orbit → Intelligence → ChatGPT plan**, and select **Get my command**. (The same flow also remains in **Settings**.)
2. Copy the command shown. On a trusted computer, clone this repository and run `npm install`.
3. Run the copied command. It looks like:

   ```bash
   npm run chatgpt:connect -- --host-id urn:uuid:YOUR-INSTALLATION-ID
   ```

4. Your browser opens OpenAI's authorization page. Sign in and approve access.
5. The helper writes `orbit-chatgpt-credentials.json` with owner-only file permissions. It never prints tokens to the terminal.
6. Return to Orbit Settings and import that file. Orbit validates it against OpenAI, confirms that it belongs to this installation, and encrypts it before PostgreSQL storage.
7. Delete the local JSON file after the import succeeds. Never commit, share, email, or upload it anywhere else.
8. Choose **ChatGPT plan (preview)**, select one of the models returned for your account, and save AI settings.

The local callback binds only to `127.0.0.1` and uses OAuth state, nonce, and PKCE S256. Each Orbit installation receives a stable random host ID, so a credential bundle generated for one installation cannot be imported into another.

## Data and limitations

- Orbit sends bounded message excerpts, normalized signals, tasks, and prompts only when needed for classification, briefs, or Ask Orbit.
- Requests use `store:false` and consume the response stream through completion.
- Orbit cannot access your ChatGPT conversations, memory, custom instructions, or password.
- Access tokens are refreshed server-side and rotating refresh tokens are re-encrypted after refresh.
- Disconnect attempts to revoke the refresh token and always deletes the stored local credentials.
- The feature is an OpenAI preview. Unsupported endpoints and features are intentionally not emulated.

Official references: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
