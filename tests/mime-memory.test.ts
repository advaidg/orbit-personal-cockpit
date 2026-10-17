import { describe, expect, it } from 'vitest';
import { buildRawMessage, cleanHeader, replySubject } from '../server/mime.js';
import { adjustTriage, isIgnored, requiresLocalProcessing, withinWorkingHours } from '../server/agent/memoryRules.js';
import type { Memory } from '../server/agent/types.js';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const memory = (type: Memory['type'], params: Memory['params'], enabled = true): Memory => ({ id: 'm', userId: 'u', createdAt: '', updatedAt: '', type, statement: '', params, source: { kind: 'owner' }, enabled, localOnly: false });

describe('draft MIME builder', () => {
  it('builds a threaded plain-text reply', () => {
    const text = decode(buildRawMessage({ to: 'maya@example.com', subject: 'Re: Launch', body: 'Hi Maya,\n\nThanks!', inReplyTo: '<abc@mail>', references: '<root@mail> <abc@mail>', idempotencyKey: 'exec:1' }));
    expect(text).toContain('To: maya@example.com');
    expect(text).toContain('In-Reply-To: <abc@mail>');
    expect(text).toContain('X-Orbit-Key: exec:1');
    const body = text.split('\r\n\r\n')[1];
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hi Maya,\r\n\r\nThanks!');
  });

  it('cannot be tricked into adding headers or recipients', () => {
    const evil = decode(buildRawMessage({ to: 'maya@example.com', subject: 'Hi\r\nBcc: attacker@example.com', body: 'x', inReplyTo: '<a>\r\nBcc: attacker@example.com' }));
    const headerBlock = evil.split('\r\n\r\n')[0];
    expect(headerBlock.split('\r\n').some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(() => buildRawMessage({ to: 'a@example.com, b@example.com', subject: 's', body: 'x' })).toThrow(/single plain email/);
    expect(() => buildRawMessage({ to: 'Maya <maya@example.com>', subject: 's', body: 'x' })).toThrow(/single plain email/);
    expect(() => buildRawMessage({ to: 'a@example.com\r\nBcc: b@example.com', subject: 's', body: 'x' })).toThrow();
  });

  it('encodes non-ASCII subjects and avoids stacking Re:', () => {
    expect(decode(buildRawMessage({ to: 'a@example.com', subject: 'Café ☕', body: 'x' }))).toContain('Subject: =?UTF-8?B?');
    expect(replySubject('Re: hello')).toBe('Re: hello');
    expect(replySubject('hello')).toBe('Re: hello');
    expect(cleanHeader('a\nb\r\nc')).toBe('a b c');
  });
});

describe('memory rules', () => {
  it('ignores senders and domains the owner muted', () => {
    const rules = [memory('inbox_rule', { action: 'ignore', senderEmail: 'spam@vendor.com' }), memory('inbox_rule', { action: 'ignore', domain: 'noise.io' })];
    expect(isIgnored(rules, 'Vendor <SPAM@vendor.com>')).toBe(true);
    expect(isIgnored(rules, 'a@sub.noise.io')).toBe(false);
    expect(isIgnored(rules, 'a@noise.io')).toBe(true);
    expect(isIgnored([memory('inbox_rule', { action: 'ignore', senderEmail: 'spam@vendor.com' }, false)], 'spam@vendor.com')).toBe(false);
  });

  it('keeps restricted senders away from external AI', () => {
    expect(requiresLocalProcessing([memory('privacy_restriction', { senderEmail: 'lawyer@firm.com', scope: 'no_external_ai' })], 'Lawyer <lawyer@firm.com>')).toBe(true);
    expect(requiresLocalProcessing([], 'x@y.com')).toBe(false);
  });

  it('raises priority for important people and never lowers it', () => {
    const rules = [memory('important_person', { email: 'maya@example.com' })];
    expect(adjustTriage(rules, 'Maya <maya@example.com>', { category: 'noise', priority: 'later' })).toEqual({ category: 'people', priority: 'now' });
    expect(adjustTriage(rules, 'other@example.com', { category: 'action', priority: 'soon' })).toEqual({ category: 'action', priority: 'soon' });
  });

  it('applies working hours', () => {
    const rules = [memory('working_hours', { startHour: 9, endHour: 17, days: ['1', '2', '3', '4', '5'] })];
    expect(withinWorkingHours(rules, 10, 3)).toBe(true);
    expect(withinWorkingHours(rules, 20, 3)).toBe(false);
    expect(withinWorkingHours(rules, 10, 0)).toBe(false);
    expect(withinWorkingHours([], 3, 0)).toBe(true);
  });
});
