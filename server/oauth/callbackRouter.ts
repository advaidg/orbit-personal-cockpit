import express from 'express';
import { ActionableError, logSafe, redact } from '../diagnostics.js';
import { publicBaseUrl } from '../pacts/config.js';
import { finishChatGPTFromCallback } from './chatgptAuth.js';

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

function page(ok: boolean, detail: string): string {
  const back = `${publicBaseUrl()}/#/connections`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${ok ? 'ChatGPT connected' : 'Sign-in not finished'}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11160f;color:#e7eee0;font:16px/1.5 system-ui,sans-serif}main{max-width:480px;padding:32px}h1{margin:0 0 8px;color:${ok ? '#c8f06b' : '#ff9d7c'};font-size:26px}p{color:#a9b39f}a{display:inline-block;margin-top:14px;padding:11px 18px;border-radius:10px;background:#c8f06b;color:#11160f;text-decoration:none;font-weight:700}</style></head><body><main><h1>${ok ? 'ChatGPT connected' : 'Sign-in not finished'}</h1><p>${esc(detail)}</p><a href="${esc(back)}">Back to Orbit</a></main></body></html>`;
}

/**
 * Where OpenAI sends the browser back to when Orbit runs on the owner's own computer. It has no session (the browser
 * arrives on 127.0.0.1); the single-use, unguessable state value identifies the sign-in instead.
 */
export function chatgptCallbackRouter(): express.Router {
  const router = express.Router();
  router.get('/auth/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const { email } = await finishChatGPTFromCallback(typeof req.query.state === 'string' ? req.query.state : '', query);
      res.type('html').send(page(true, `${email ?? 'Your ChatGPT plan'} is connected. Return to Orbit and choose a model.`));
    } catch (error) {
      if (!(error instanceof ActionableError)) logSafe('chatgpt callback', error);
      const message = error instanceof ActionableError ? `${error.message} ${error.options.action ?? ''}`.trim() : 'Something went wrong. Try again from Orbit.';
      res.status(400).type('html').send(page(false, redact(message, 240)));
    }
  });
  return router;
}
