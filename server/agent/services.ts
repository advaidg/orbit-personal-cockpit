/**
 * Seams between tools and outside providers. Production wires real Google/Telegram/SMTP implementations;
 * tests inject fakes, which is how every tool is exercised without touching a real account.
 */
export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** Stored in an X-Orbit-Key header so an interrupted attempt can be found instead of duplicated. */
  idempotencyKey?: string;
}

export interface MessageHeaders {
  threadId?: string;
  from: string;
  replyTo?: string;
  to?: string;
  subject: string;
  messageIdHeader?: string;
  references?: string;
}

export interface GmailGateway {
  /** Reports whether Gmail is connected and whether the stored grant includes draft creation. */
  capabilities(userId: string, connectionId?: string): Promise<{ connected: boolean; canDraft: boolean; connectionId?: string; accountEmail?: string }>;
  getMessageHeaders(userId: string, connectionId: string | undefined, messageId: string): Promise<MessageHeaders>;
  createDraft(userId: string, connectionId: string | undefined, draft: DraftInput): Promise<{ draftId: string; messageId?: string; threadId?: string }>;
  getDraft(userId: string, connectionId: string | undefined, draftId: string): Promise<{ exists: boolean; threadId?: string; to?: string; subject?: string }>;
  deleteDraft(userId: string, connectionId: string | undefined, draftId: string): Promise<void>;
  /** Looks for a draft carrying our idempotency key, used to recover from an interrupted attempt. */
  findDraftByKey?(userId: string, connectionId: string | undefined, key: string): Promise<{ draftId: string; threadId?: string } | null>;
}

export interface CalendarEventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

export interface CalendarGateway {
  capabilities(userId: string): Promise<{ connected: boolean; canWrite: boolean; connectionId?: string }>;
  createEvent(userId: string, event: CalendarEventInput): Promise<{ eventId: string; htmlLink?: string }>;
  getEvent(userId: string, eventId: string): Promise<{ exists: boolean; title?: string; startsAt?: string }>;
  deleteEvent(userId: string, eventId: string): Promise<void>;
}

export type NotifyChannel = 'in_app' | 'browser' | 'email' | 'telegram';

export interface DeliveryResult {
  channel: NotifyChannel;
  ok: boolean;
  detail: string;
}

export interface NotifierGateway {
  deliver(userId: string, message: { title: string; body: string; kind: 'reminder' | 'digest' | 'alert' | 'failure' | 'info'; runId?: string; link?: string }, channels: NotifyChannel[]): Promise<DeliveryResult[]>;
}

export interface ToolServices {
  gmail: GmailGateway;
  calendar: CalendarGateway;
  notifier: NotifierGateway;
}

const unavailable = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} gateway is not configured`);
};

let current: ToolServices = {
  gmail: { capabilities: async () => ({ connected: false, canDraft: false }), getMessageHeaders: unavailable('gmail'), createDraft: unavailable('gmail'), getDraft: unavailable('gmail'), deleteDraft: unavailable('gmail') },
  calendar: { capabilities: async () => ({ connected: false, canWrite: false }), createEvent: unavailable('calendar'), getEvent: unavailable('calendar'), deleteEvent: unavailable('calendar') },
  notifier: { deliver: async () => [] }
};

export const services = (): ToolServices => current;

/** Replaces any subset of gateways. Returns a function that restores the previous set (for tests). */
export function setServices(partial: Partial<ToolServices>): () => void {
  const previous = current;
  current = { ...current, ...partial };
  return () => {
    current = previous;
  };
}
