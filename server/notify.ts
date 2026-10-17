import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { Collection } from './collection.js';
import { redact, ActionableError } from './diagnostics.js';
import { providerLimiter } from './providerLimits.js';
import { getUser } from './store.js';
import { getAgentSettings } from './agent/settings.js';
import type { DeliveryResult, NotifierGateway, NotifyChannel } from './agent/services.js';
import type { OrbitNotification } from './agent/types.js';

export const notifications = new Collection<OrbitNotification>('notifications');

type Message = Parameters<NotifierGateway['deliver']>[1];

export interface NotifierDeps {
  sendEmail: (to: string, subject: string, text: string) => Promise<void>;
  sendTelegram: (chatId: string, text: string) => Promise<void>;
}

async function defaultSendEmail(to: string, subject: string, text: string): Promise<void> {
  const url = process.env.SMTP_URL;
  if (!url) throw new ActionableError('Email digests are not configured.', { action: 'Set SMTP_URL (and optionally DIGEST_FROM) on this installation.', code: 'smtp_missing' });
  const transport = nodemailer.createTransport(url);
  await providerLimiter.run('smtp', () => transport.sendMail({ from: process.env.DIGEST_FROM || process.env.OWNER_EMAIL, to, subject, text }));
}

async function defaultSendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new ActionableError('Telegram is not configured.', { action: 'Set TELEGRAM_BOT_TOKEN on this installation, then add your chat ID in Connections.', code: 'telegram_missing' });
  const response = await providerLimiter.run('telegram', () => fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }) }));
  if (!response.ok) throw new Error(`Telegram rejected the message (${response.status})`);
}

export async function createNotification(userId: string, input: Pick<OrbitNotification, 'title' | 'body' | 'kind'> & Partial<Pick<OrbitNotification, 'runId' | 'link'>>): Promise<OrbitNotification> {
  const item: OrbitNotification = { id: crypto.randomUUID(), userId, createdAt: new Date().toISOString(), title: input.title.slice(0, 160), body: input.body.slice(0, 4000), kind: input.kind, read: false, runId: input.runId, link: input.link };
  return (await notifications.insert(item)).item;
}

/** Delivers one message through the requested channels, reporting each channel's outcome separately. */
export function createNotifier(deps: Partial<NotifierDeps> = {}): NotifierGateway {
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const sendTelegram = deps.sendTelegram ?? defaultSendTelegram;
  return {
    async deliver(userId: string, message: Message, channels: NotifyChannel[]): Promise<DeliveryResult[]> {
      const results: DeliveryResult[] = [];
      const settings = await getAgentSettings(userId);
      const wanted = [...new Set(channels)];
      if (wanted.includes('in_app') || wanted.includes('browser')) {
        await createNotification(userId, message);
        results.push({ channel: 'in_app', ok: true, detail: 'Saved to your notification center.' });
      }
      for (const channel of wanted.filter((value) => value === 'email' || value === 'telegram')) {
        try {
          if (channel === 'email') {
            const to = process.env.DIGEST_TO || (await getUser(userId))?.email;
            if (!to) throw new ActionableError('No address is available for the digest.', { action: 'Set DIGEST_TO or OWNER_EMAIL.' });
            await sendEmail(to, `Orbit: ${message.title}`, `${message.body}\n\n— Orbit`);
            results.push({ channel, ok: true, detail: 'Sent by email.' });
          } else {
            const chatId = settings.channels.telegram.chatId;
            if (!chatId) throw new ActionableError('No Telegram chat is linked.', { action: 'Add your Telegram chat ID in Connections.' });
            await sendTelegram(chatId, `${message.title}\n\n${message.body}`);
            results.push({ channel, ok: true, detail: 'Sent to Telegram.' });
          }
        } catch (error) {
          results.push({ channel, ok: false, detail: redact(error instanceof Error ? error.message : 'Delivery failed', 200) });
        }
      }
      return results;
    }
  };
}

export const notifier = createNotifier();

/** Channels the owner enabled for scheduled digests and reminders. */
export async function ownerChannels(userId: string): Promise<NotifyChannel[]> {
  const settings = await getAgentSettings(userId);
  const channels: NotifyChannel[] = ['in_app'];
  if (settings.channels.browser) channels.push('browser');
  if (settings.channels.email) channels.push('email');
  if (settings.channels.telegram.enabled && settings.channels.telegram.chatId) channels.push('telegram');
  return channels;
}
