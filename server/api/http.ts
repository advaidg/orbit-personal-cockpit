import type express from 'express';
import { z } from 'zod';
import { ActionableError } from '../diagnostics.js';
import { agentLimits } from '../agent/config.js';
import { demoUser } from '../demo.js';

export const ownerId = (res: express.Response): string => res.locals.userId as string;

const STATUS: Record<string, number> = { not_found: 404, not_pending: 409, not_failed: 409, already_undone: 409, policy_blocked: 409, not_allowable: 400, agent_disabled: 403, skills_disabled: 403, mcp_disabled: 403, memory_disabled: 403, run_limit: 429, scope_required: 409 };

/** Maps owner-actionable failures to a status and a body that always says what to do next. */
export function sendFailure(res: express.Response, error: unknown): void {
  if (error instanceof ActionableError) {
    res.status(STATUS[error.options.code ?? ''] ?? 400).json({ error: error.message, action: error.options.action, code: error.options.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: `Invalid request: ${error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')}`, code: 'invalid_request' });
    return;
  }
  throw error;
}

/** Wraps a handler so ActionableError and validation failures become clean JSON responses. */
export function handle(fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      try {
        sendFailure(res, error);
      } catch (unhandled) {
        next(unhandled);
      }
    }
  };
}

/** Blocks changes when the installation turned the agent off. Reads stay available so the UI can explain why. */
export const requireAgentEnabled: express.RequestHandler = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || agentLimits().enabled) return next();
  res.status(403).json({ error: 'The agent is disabled on this installation.', action: 'Set AGENT_ENABLED=true and redeploy to turn it on.', code: 'agent_disabled' });
};

/**
 * Setup changes things that belong to the whole installation (bot tokens, API keys, mail server). The sample
 * workspace is not an owner, so it can never reach them, whatever DEMO_MODE says.
 */
export const forbidDemo: express.RequestHandler = (_req, res, next) => {
  if (res.locals.userId === demoUser.id) return void res.status(403).json({ error: 'Setup is not available in the demo workspace.', action: 'Sign in as the installation owner.', code: 'demo_mode' });
  next();
};
