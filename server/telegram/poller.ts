import { logSafe } from '../diagnostics.js';
import { pactLimits } from '../pacts/config.js';
import { listPending } from '../agent/proposals.js';
import { getBotToken, realTelegramApi, telegramApi } from './api.js';
import { onSettingChange } from '../installationConfig.js';
import { handleUpdate, sendProposalCards } from './bot.js';
import { boundChats } from './link.js';

const POLL_SECONDS = 25;
const MAX_BACKOFF_MS = 60_000;

interface PollHealth { lastOkAt?: string; lastError?: { at: string; message: string } }
const health: PollHealth = {};
/** What the Diagnostics screen shows about the Telegram connection. */
export const telegramHealth = (): PollHealth => ({ ...health });

export const telegramConfigured = (): boolean => !!getBotToken();

/**
 * Long-polls Telegram, so no public webhook is needed — it works behind any host. Only one instance may poll
 * per bot token; a second one backs off quietly. The loop re-reads the token every round, so saving, replacing
 * or removing the bot in Setup takes effect within a moment, with no redeploy.
 */
export function startTelegramBot(): { stop: () => void } {
  if (!pactLimits().telegramInbound) return { stop: () => undefined };
  let controller = new AbortController();
  let offset = 0;
  let delay = 1_000;
  let stopped = false;
  let lastToken: string | undefined;
  const unsubscribe = onSettingChange((key) => {
    if (key === 'TELEGRAM_BOT_TOKEN') controller.abort();
  });
  void (async () => {
    while (!stopped) {
      const token = getBotToken();
      if (!token) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        continue;
      }
      if (token !== lastToken) {
        lastToken = token;
        offset = 0;
      }
      controller = new AbortController();
      try {
        const updates = await telegramApi().getUpdates(offset, POLL_SECONDS, controller.signal);
        delay = 1_000;
        health.lastOkAt = new Date().toISOString();
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(update);
        }
      } catch (error) {
        if (stopped) break;
        if (controller.signal.aborted) continue; // the token changed; start over with the new one
        const status = (error as { status?: number }).status;
        health.lastError = { at: new Date().toISOString(), message: status === 409 ? 'Another copy of Orbit is polling this bot.' : status === 401 ? 'Telegram rejected the bot token.' : 'Could not reach Telegram.' };
        logSafe(status === 409 ? 'telegram polling conflict (another instance polls this bot)' : 'telegram polling', error);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(MAX_BACKOFF_MS, delay * (status === 409 ? 4 : 2));
      }
    }
  })();
  return { stop: () => { stopped = true; unsubscribe(); controller.abort(); } };
}

/** Pushes newly pending proposals to the owner's linked chat, once each. Called from the scheduler. */
export async function announcePendingProposals(now = new Date()): Promise<number> {
  if (telegramApi() === realTelegramApi && !telegramConfigured()) return 0;
  let sent = 0;
  for (const { userId, chatId } of await boundChats()) {
    const fresh = (await listPending(userId)).filter((proposal) => !proposal.telegramNotifiedAt);
    if (fresh.length) sent += await sendProposalCards(telegramApi(), userId, chatId, fresh, now);
  }
  return sent;
}
