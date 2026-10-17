import { logSafe } from '../diagnostics.js';
import { pactLimits } from '../pacts/config.js';
import { listPending } from '../agent/proposals.js';
import { realTelegramApi, telegramApi } from './api.js';
import { handleUpdate, sendProposalCards } from './bot.js';
import { boundChats } from './link.js';

const POLL_SECONDS = 25;
const MAX_BACKOFF_MS = 60_000;

export const telegramConfigured = (): boolean => !!process.env.TELEGRAM_BOT_TOKEN;

/**
 * Long-polls Telegram, so no public webhook is needed — it works behind any host. Only one instance may poll
 * per bot token; a second one backs off quietly.
 */
export function startTelegramBot(): { stop: () => void } {
  if (!telegramConfigured() || !pactLimits().telegramInbound) return { stop: () => undefined };
  const controller = new AbortController();
  let offset = 0;
  let delay = 1_000;
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const updates = await telegramApi().getUpdates(offset, POLL_SECONDS, controller.signal);
        delay = 1_000;
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(update);
        }
      } catch (error) {
        if (stopped) break;
        const status = (error as { status?: number }).status;
        logSafe(status === 409 ? 'telegram polling conflict (another instance polls this bot)' : 'telegram polling', error);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(MAX_BACKOFF_MS, delay * (status === 409 ? 4 : 2));
      }
    }
  })();
  return { stop: () => { stopped = true; controller.abort(); } };
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
