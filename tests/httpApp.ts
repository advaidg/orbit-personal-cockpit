import type { AddressInfo } from 'node:net';
import express from 'express';
import { publicPactRouter } from '../server/pacts/publicRouter.js';
import { federationPublicRouter } from '../server/federation/router.js';
import { pactsRouter } from '../server/api/pacts.js';
import { federationRouter } from '../server/api/federation.js';
import { channelsRouter } from '../server/api/channels.js';
import { sendFailure } from '../server/api/http.js';
import { setupRouter } from '../server/api/setup.js';
import { chatgptCallbackRouter } from '../server/oauth/callbackRouter.js';

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** The same routers the real app mounts, with the signed-in owner fixed to `ownerId`. */
export async function startApp(ownerId: string): Promise<TestServer> {
  const app = express();
  app.use(chatgptCallbackRouter());
  app.use('/p', publicPactRouter());
  app.use(federationPublicRouter());
  app.use(express.json());
  const owner: express.RequestHandler = (_req, res, next) => { res.locals.userId = ownerId; next(); };
  app.use('/api/pacts', owner, pactsRouter);
  app.use('/api/federation', owner, federationRouter);
  app.use('/api/channels', owner, channelsRouter);
  app.use('/api/setup', owner, setupRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    try { sendFailure(res, error); } catch { res.status(500).json({ error: 'unexpected' }); }
  });
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
