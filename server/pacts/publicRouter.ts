import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ActionableError, logSafe } from '../diagnostics.js';
import { pactLimits } from './config.js';
import { notFoundPage, pactPage } from './page.js';
import { applyAction, pactForToken, publicView, roleOf, ALLOWED, splitToken } from './service.js';

const THANKS: Record<string, string> = {
  confirm: 'Thanks — noted.',
  done: 'Marked as done. Thank you.',
  reschedule: 'New date sent.',
  decline: 'Understood — thanks for saying so.',
  cancel: 'Closed. Thanks for letting them know.'
};

const body = z.object({
  action: z.enum(['confirm', 'done', 'reschedule', 'decline', 'cancel']),
  note: z.string().max(1000).optional(),
  date: z.string().max(40).optional()
});

const limiter = (limit: number) => rateLimit({ windowMs: 10 * 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: 'Too many requests. Try again in a few minutes.' });
/** Counts attempts per token as well, so a leaked link cannot be hammered from many addresses. */
const perToken = rateLimit({ windowMs: 10 * 60_000, limit: 40, standardHeaders: false, legacyHeaders: false, keyGenerator: (req) => `pact:${String(req.params.token).slice(0, 80)}`, validate: { keyGeneratorIpFallback: false }, message: 'Too many requests. Try again in a few minutes.' });

/**
 * The only unauthenticated surface that changes data. A link is a capability: it names one pact, can be revoked,
 * expires, and exposes only the promise itself. No cookies are read or set.
 */
export function publicPactRouter(): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  router.use(limiter(120));
  router.use('/:token', perToken);
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));

  const gone = (res: express.Response) => res.status(404).type('html').send(notFoundPage(pactLimits().repoUrl));

  router.get('/:token', async (req, res) => {
    try {
      if (!pactLimits().enabled) return gone(res);
      const pact = await pactForToken(String(req.params.token));
      if (!pact) return gone(res);
      const thanks = typeof req.query.done === 'string' ? THANKS[req.query.done] : undefined;
      res.type('html').send(pactPage({ pact: await publicView(pact), repoUrl: pactLimits().repoUrl, thanks }));
    } catch (error) {
      logSafe('pact page', error);
      res.status(500).type('text').send('Something went wrong.');
    }
  });

  router.post('/:token', async (req, res) => {
    try {
      if (!pactLimits().enabled) return gone(res);
      const token = String(req.params.token);
      const pact = await pactForToken(token);
      if (!pact) return gone(res);
      const parsed = body.safeParse(req.body);
      if (!parsed.success) return res.status(400).type('html').send(pactPage({ pact: await publicView(pact), repoUrl: pactLimits().repoUrl, error: 'That didn’t look right.' }));
      const { action, note, date } = parsed.data;
      if (!ALLOWED[roleOf(pact.direction, 'counterparty')].includes(action)) return res.status(400).type('html').send(pactPage({ pact: await publicView(pact), repoUrl: pactLimits().repoUrl, error: 'That option isn’t available here.' }));
      try {
        await applyAction(pact.userId, pact.id, 'counterparty', action, { note, date });
      } catch (error) {
        if (!(error instanceof ActionableError)) throw error;
        const fresh = (await pactForToken(token)) ?? pact;
        return res.status(error.options.code === 'pact_closed' ? 409 : 400).type('html').send(pactPage({ pact: await publicView(fresh), repoUrl: pactLimits().repoUrl, error: error.message }));
      }
      // Post/Redirect/Get so a refresh cannot repeat the action.
      res.redirect(303, `/p/${splitToken(token) ? token : ''}?done=${action}`);
    } catch (error) {
      logSafe('pact response', error);
      res.status(500).type('text').send('Something went wrong.');
    }
  });

  // Oversize or malformed bodies end here instead of reaching the app-wide error handler.
  router.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : 400).type('text').send('That request was too large or malformed.');
  });

  return router;
}
