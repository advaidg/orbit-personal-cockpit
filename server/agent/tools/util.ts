import crypto from 'node:crypto';
import { z } from 'zod';

export const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Use an ISO date and time').transform((value) => new Date(value).toISOString());
export const priority = z.enum(['now', 'soon', 'later']);
export const id = z.string().min(1).max(100);

/** Short, stable slug for building dedupe keys from free text. */
export function slug(text: string, length = 48): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, length) || crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

export function extractEmail(value: string | undefined): string | undefined {
  const match = value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0].toLowerCase();
}

export function displayName(value: string | undefined): string {
  if (!value) return 'the sender';
  const name = value.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return name || extractEmail(value) || 'the sender';
}
