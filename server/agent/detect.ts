import { localDayAt, partsInZone, zonedTimeToUtc } from './time.js';

/**
 * Deterministic text analysis for commitments, completions and deadlines. Email text is untrusted data:
 * these functions only extract structured hints from it and never execute or obey anything inside it.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DEFAULT_HOUR = 17;

function monthIndex(name: string): number {
  return MONTHS.findIndex((month) => month.startsWith(name.slice(0, 3).toLowerCase()));
}

interface DateMatch {
  index: number;
  date: Date;
}

/** Finds the earliest date phrase in `text`. Deadlines default to 17:00 local time. */
export function parseExpectedDate(text: string, now: Date, timeZone = 'UTC'): string | null {
  const lower = text.toLowerCase();
  const today = partsInZone(now, timeZone);
  const matches: DateMatch[] = [];
  const at = (days: number, hour = DEFAULT_HOUR) => localDayAt(now, days, hour, 0, timeZone);
  const add = (index: number | undefined, date: Date) => { if (index !== undefined && index >= 0) matches.push({ index, date }); };

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (iso) add(iso.index, localDayAt(new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12)), 0, DEFAULT_HOUR, 0, timeZone));

  const monthDay = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(lower);
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(lower);
  for (const hit of [monthDay && { index: monthDay.index, month: monthDay[1], day: monthDay[2], year: monthDay[3] }, dayMonth && { index: dayMonth.index, month: dayMonth[2], day: dayMonth[1], year: dayMonth[3] }]) {
    if (!hit) continue;
    const month = monthIndex(hit.month);
    const day = Number(hit.day);
    if (month < 0 || day < 1 || day > 31) continue;
    let year = hit.year ? Number(hit.year) : today.year;
    let candidate = localDayAt(new Date(Date.UTC(year, month, day, 12)), 0, DEFAULT_HOUR, 0, timeZone);
    if (!hit.year && candidate.getTime() < now.getTime() - 86_400_000) {
      year += 1;
      candidate = localDayAt(new Date(Date.UTC(year, month, day, 12)), 0, DEFAULT_HOUR, 0, timeZone);
    }
    add(hit.index, candidate);
  }

  const relative = /\bin\s+(\d{1,3})\s+(hour|day|week|business day)s?\b/.exec(lower);
  if (relative) {
    const n = Number(relative[1]);
    if (relative[2] === 'hour') add(relative.index, new Date(now.getTime() + n * 3_600_000));
    else add(relative.index, at(relative[2] === 'week' ? n * 7 : n));
  }

  const tomorrowMorning = /\btomorrow\s+morning\b/.exec(lower);
  if (tomorrowMorning) add(tomorrowMorning.index, at(1, 9));
  else {
    const tomorrow = /\btomorrow\b/.exec(lower);
    if (tomorrow) add(tomorrow.index, at(1));
  }
  const todayHit = /\b(today|tonight|eod|end of (?:the )?day|cob|close of business)\b/.exec(lower);
  if (todayHit) add(todayHit.index, today.hour >= DEFAULT_HOUR ? at(0, 23) : at(0));

  const weekday = new RegExp(`\\b(?:(next|this)\\s+)?(?:by\\s+|on\\s+|before\\s+)?(${DAY_NAMES.join('|')})\\b`).exec(lower);
  if (weekday) {
    const target = DAY_NAMES.indexOf(weekday[2]);
    let ahead = (target - today.weekday + 7) % 7;
    if (ahead === 0) ahead = 7;
    // "next Friday" skips the occurrence that falls in the current Monday–Sunday week.
    if (weekday[1] === 'next' && today.weekday + ahead <= 7 && today.weekday !== 0 && target !== 0) ahead += 7;
    add(weekday.index, at(ahead));
  }

  const nextWeek = /\b(?:by\s+)?(?:the\s+)?(?:end of\s+)?next week\b/.exec(lower);
  if (nextWeek) {
    const endOfNext = /end of next week/.test(lower);
    const mondayAhead = ((8 - today.weekday) % 7) || 7;
    add(nextWeek.index, at(mondayAhead + (endOfNext ? 4 : 0)));
  }
  const endOfWeek = /\b(end of (?:the |this )?week|eow)\b/.exec(lower);
  if (endOfWeek && !/end of next week/.test(lower)) {
    const fridayAhead = (5 - today.weekday + 7) % 7;
    add(endOfWeek.index, at(fridayAhead === 0 && today.hour >= DEFAULT_HOUR ? 7 : fridayAhead));
  }
  const endOfMonth = /\bend of (?:the |this )?month\b/.exec(lower);
  if (endOfMonth) {
    const last = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();
    add(endOfMonth.index, at(last - today.day));
  }

  if (!matches.length) return null;
  matches.sort((a, b) => a.index - b.index);
  return matches[0].date.toISOString();
}

/** Removes quoted reply history so old messages are not mistaken for new promises. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*on .{5,120} wrote:\s*$/i.test(line) || /^\s*-{2,}\s*original message\s*-{2,}/i.test(line) || /^\s*from:\s.+/i.test(line) && kept.length > 2) break;
    kept.push(line);
  }
  return kept.join('\n');
}

export interface CommitmentCandidate {
  direction: 'i_owe' | 'they_owe';
  otherPerson: string;
  otherEmail?: string;
  action: string;
  expectedAt?: string;
  evidence: string;
  confidence: number;
}

export interface DetectContext {
  /** Whether the owner wrote the message (`outbound`) or received it (`inbound`). */
  messageDirection: 'inbound' | 'outbound';
  otherPerson: string;
  otherEmail?: string;
  now: Date;
  timeZone?: string;
}

const VERBS = 'send|share|get back|follow up|circle back|review|confirm|update|check|forward|schedule|book|deliver|finish|prepare|look into|take a look|loop in|introduce|reply|respond|draft|put together|provide|submit|sign|approve';
const PROMISE = new RegExp(`\\b(?:i(?:'ll|’ll| will| can| am going to|'m going to|’m going to)|we(?:'ll|’ll| will| can)|let me|i'?ll make sure to)\\b[^.?!\\n]{0,80}?\\b(${VERBS})\\b([^.?!\\n]*)`, 'i');
const REQUEST_MODAL = new RegExp(`\\b(?:can|could|would|will) you\\b[^.?!\\n]{0,100}?\\b(${VERBS}|let me know)\\b([^.?!\\n]*)`, 'i');
const REQUEST_PLEASE = new RegExp(`\\bplease\\b[^.?!\\n]{0,80}?\\b(${VERBS}|let me know)\\b([^.?!\\n]*)`, 'i');
const LET_ME_KNOW = /\blet me know\b(?!\s+(?:if|whether)\b)([^.?!\n]*)/i;
const WAITING = /\bwaiting (?:on|for) you\b([^.?!\n]*)/i;
const BOILERPLATE = /\b(unsubscribe|no[- ]?reply|do not reply|view in browser|privacy policy)\b/i;

function capitalize(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

/** Finds promises and requests in a message body and attributes each to the right person. */
export function detectCommitments(rawText: string, context: DetectContext): CommitmentCandidate[] {
  if (BOILERPLATE.test(rawText.slice(0, 4000)) && !/\b(i'll|i will|can you|could you|please)\b/i.test(rawText)) return [];
  const sentences = stripQuoted(rawText)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 300);
  const found: CommitmentCandidate[] = [];
  const seen = new Set<string>();

  for (const sentence of sentences) {
    let kind: 'promise' | 'request' | null = null;
    let action = '';
    let match: RegExpExecArray | null;
    if ((match = PROMISE.exec(sentence))) { kind = 'promise'; action = `${match[1]}${match[2]}`; }
    else if ((match = REQUEST_MODAL.exec(sentence)) || (match = REQUEST_PLEASE.exec(sentence))) { kind = 'request'; action = `${match[1]}${match[2] ?? ''}`; }
    else if ((match = LET_ME_KNOW.exec(sentence))) { kind = 'request'; action = `let me know${match[1]}`; }
    else if ((match = WAITING.exec(sentence))) { kind = 'request'; action = `reply${match[1]}`; }
    if (!kind || !action.trim()) continue;

    const inbound = context.messageDirection === 'inbound';
    // Promises are owed by the writer; requests are owed by the reader.
    const direction: CommitmentCandidate['direction'] = kind === 'promise' ? (inbound ? 'they_owe' : 'i_owe') : (inbound ? 'i_owe' : 'they_owe');
    const expectedAt = parseExpectedDate(sentence, context.now, context.timeZone) ?? undefined;
    const key = `${direction}:${action.toLowerCase().replace(/\W+/g, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      direction, otherPerson: context.otherPerson, otherEmail: context.otherEmail, action: capitalize(action).slice(0, 200),
      expectedAt, evidence: sentence.slice(0, 200), confidence: Math.min(0.95, 0.55 + (expectedAt ? 0.2 : 0) + (context.otherEmail ? 0.1 : 0))
    });
  }
  return found.slice(0, 3);
}

export interface ResolutionHint {
  /** True when the text itself reads like a completion, not merely a reply. */
  strong: boolean;
  excerpt?: string;
}

const COMPLETION = /\b(attached|attaching|here(?:'s| is| are)|sent (?:it|them|over)|all set|done|completed?|approved|confirmed|signed|looks good|sounds good|lgtm|got it|received|i(?:'ve| have) (?:sent|shared|updated|finished|completed|booked|scheduled))\b/i;

export function detectResolution(rawText: string): ResolutionHint {
  for (const sentence of stripQuoted(rawText).split(/(?<=[.!?])\s+|\n+/)) {
    if (COMPLETION.test(sentence) && sentence.length <= 300) return { strong: true, excerpt: sentence.trim().slice(0, 200) };
  }
  return { strong: false };
}

const DEADLINE = /\b(due|deadline|no later than|before|until|expires?|payment due|renewal|submit by|respond by|reply by|by)\b/i;

/** Finds the earliest future date attached to deadline language (outside sentences listed in `exclude`). */
export function detectDeadline(rawText: string, now: Date, timeZone = 'UTC', exclude: string[] = []): { dueAt: string; excerpt: string } | null {
  let best: { dueAt: string; excerpt: string } | null = null;
  for (const raw of stripQuoted(rawText).split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    // Sentences already captured as commitments carry their own date; do not double count them.
    if (sentence.length > 300 || !DEADLINE.test(sentence) || exclude.some((used) => used.startsWith(sentence.slice(0, 200)))) continue;
    const dueAt = parseExpectedDate(sentence, now, timeZone);
    if (!dueAt || dueAt <= now.toISOString()) continue;
    if (!best || dueAt < best.dueAt) best = { dueAt, excerpt: sentence.trim().slice(0, 200) };
  }
  return best;
}

export const NO_REPLY = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?@|mailer-daemon|bounce|newsletter|updates?@|alerts?@)/i;

export interface EventRequest {
  title: string;
  startsAt: string;
  endsAt: string;
}

/** Parses simple scheduling requests such as "schedule dentist tomorrow at 3pm for 1 hour". */
export function parseEventRequest(text: string, now: Date, timeZone = 'UTC'): EventRequest | null {
  const day = parseExpectedDate(text, now, timeZone);
  const time = /\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!day || !time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  const meridiem = time[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const parts = partsInZone(new Date(day), timeZone);
  const start = zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour, minute }, timeZone);
  const duration = /\bfor\s+(\d+(?:\.\d+)?)\s*(hour|hr|minute|min)s?\b/i.exec(text);
  const minutes = duration ? Math.round(Number(duration[1]) * (/^h/i.test(duration[2]) ? 60 : 1)) : 60;
  const title = text
    .replace(/^\s*(?:please\s+)?(?:schedule|add|book|block(?: off)?|put|create)\s+(?:a |an |the |in |on )?(?:calendar )?(?:event |meeting )?(?:called |named |for )?/i, '')
    .replace(/\b(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '')
    .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hour|hr|minute|min)s?\b/i, '')
    .replace(/\b(?:on |by )?(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight)\b/gi, '')
    .replace(/\s+/g, ' ').replace(/[.,;:\s]+$/g, '').trim();
  return { title: (title || 'Calendar event').slice(0, 120), startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
}
