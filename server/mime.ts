import type { DraftInput } from './agent/services.js';

const LINE_BREAKS = new RegExp('[\\r\\n\\u2028\\u2029]+', 'g');

/** Collapses CR/LF so a value can never smuggle in a new header. */
export function cleanHeader(value: string): string {
  return value.replace(LINE_BREAKS, ' ').replace(/\s+/g, ' ').trim();
}

function encodeSubject(subject: string): string {
  const clean = cleanHeader(subject);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

const BARE_ADDRESS = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export interface RawDraft extends DraftInput {
  /** Written into an X-Orbit-Key header so a crashed attempt can be found again instead of duplicated. */
  idempotencyKey?: string;
}

/** Builds an RFC 5322 plain-text message and returns it base64url-encoded for the Gmail API. */
export function buildRawMessage(draft: RawDraft): string {
  const to = cleanHeader(draft.to);
  if (!BARE_ADDRESS.test(to)) throw new Error('Draft recipient must be a single plain email address');
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeSubject(draft.subject)}`,
    draft.inReplyTo ? `In-Reply-To: ${cleanHeader(draft.inReplyTo)}` : '',
    draft.references ? `References: ${cleanHeader(draft.references)}` : '',
    draft.idempotencyKey ? `X-Orbit-Key: ${cleanHeader(draft.idempotencyKey)}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ].filter(Boolean);
  const body = (Buffer.from(draft.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

export function replySubject(subject: string): string {
  const clean = cleanHeader(subject) || '(no subject)';
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}
