import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { pactLimits } from '../pacts/config.js';
import { federationOwner } from './discovery.js';
import { discoveryDocument } from './identity.js';
import { handleInbound } from './inbox.js';

/** Public endpoints other Orbit installations talk to. Both answer 404 unless the owner opted in. */
export function federationPublicRouter(): express.Router {
  const router = express.Router();
  const limit = rateLimit({ windowMs: 10 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });

  router.get('/.well-known/orbit-pacts', limit, async (_req, res) => {
    const owner = pactLimits().federationEnabled ? await federationOwner() : null;
    if (!owner) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await discoveryDocument(owner.id, owner.name));
  });

  router.post('/federation/inbox', limit, express.json({ limit: '16kb' }), async (req, res) => {
    const result = await handleInbound(req.body);
    res.status(result.status).json(result.body);
  });

  router.use('/federation', (error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid_message' });
  });

  return router;
}
