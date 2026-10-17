import { providerLimiter } from '../providerLimits.js';

export interface Button {
  text: string;
  /** Callback data (at most 64 bytes) or, when `url` is set, ignored. */
  data?: string;
  url?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number; type: string } } };
}

export interface TelegramApi {
  send(chatId: string, text: string, buttons?: Button[][]): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  botUsername(): Promise<string | undefined>;
}

const TEXT_LIMIT = 3800;

async function call<T>(method: string, payload: object, signal?: AbortSignal): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!response.ok || !data.ok) throw Object.assign(new Error(`Telegram ${method} failed (${data.error_code ?? response.status})`), { status: data.error_code ?? response.status });
  return data.result as T;
}

let cachedUsername: string | undefined;

export const realTelegramApi: TelegramApi = {
  async send(chatId, text, buttons) {
    await providerLimiter.run('telegram', () => call('sendMessage', {
      chat_id: chatId, text: text.slice(0, TEXT_LIMIT), disable_web_page_preview: true,
      ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((button) => (button.url ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data }))) } } : {})
    }));
  },
  async answerCallback(callbackId, text) {
    await call('answerCallbackQuery', { callback_query_id: callbackId, text: text?.slice(0, 190) }).catch(() => undefined);
  },
  getUpdates: (offset, timeoutSeconds, signal) => call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }, signal),
  async botUsername() {
    if (cachedUsername) return cachedUsername;
    cachedUsername = (await call<{ username?: string }>('getMe', {}).catch(() => ({}) as { username?: string })).username;
    return cachedUsername;
  }
};

let current: TelegramApi = realTelegramApi;
export const telegramApi = (): TelegramApi => current;

/** Replaces the Telegram transport (tests). Returns a function that restores the previous one. */
export function setTelegramApi(api: TelegramApi): () => void {
  const previous = current;
  current = api;
  return () => { current = previous; };
}
