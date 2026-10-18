import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { logSafe } from '../diagnostics.js';
import { decide } from './engine.js';
import { HOOK_SCRIPT } from './hookScript.js';
import { agentForToken } from './store.js';
import type { HookEvent } from './types.js';

const eventSchema = z.object({
  session_id: z.string().max(200).optional(),
  cwd: z.string().max(1000).optional(),
  hook_event_name: z.string().max(60).optional(),
  tool_name: z.string().max(120).optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().max(200).optional(),
  permission_mode: z.string().max(60).optional(),
  orbit_usage: z.object({ session_id: z.string().max(200), totals: z.unknown() }).optional()
}).passthrough();

const bearer = (header: string | undefined): string => (header?.startsWith('Bearer ') ? header.slice(7).trim() : '');

/**
 * Where coding agents ask Orbit before they act. Authenticated by a per-agent token (stored only as a hash). Every
 * failure path answers "no opinion" so a bug here can never silently approve something.
 */
export function guardPublicRouter(): express.Router {
  const router = express.Router();

  router.get('/guard/hook.mjs', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/javascript').send(HOOK_SCRIPT);
  });

  const perToken = rateLimit({
    windowMs: 60_000, limit: 600, standardHeaders: false, legacyHeaders: false, validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => `guard:${bearer(req.get('authorization')).slice(0, 80) || req.ip || 'anon'}`,
    message: { error: 'rate_limited' }
  });

  router.post('/guard/v1/hook', perToken, express.json({ limit: '512kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const agent = await agentForToken(bearer(req.get('authorization')));
      if (!agent) return void res.status(401).json({ error: 'invalid_token' });
      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) return void res.json({});
      const { orbit_usage: usage, ...event } = parsed.data;
      // Only the before-a-tool-runs event is judged; anything else is none of Orbit's business.
      if (event.hook_event_name && event.hook_event_name !== 'PreToolUse') return void res.json({});
      const result = await decide({ agent, event: event as HookEvent, usage: usage ? { sessionId: usage.session_id, totals: usage.totals } : undefined });
      res.json(result.body);
    } catch (error) {
      logSafe('guard hook', error);
      res.json({});
    }
  });

  router.use('/guard', (error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid_request' });
  });

  return router;
}
