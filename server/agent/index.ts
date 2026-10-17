import { registerAgentJobs } from './jobs.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerLocalTools } from './tools/local.js';
import { registerNotifyTools } from './tools/notify.js';
import { registerSkillAdminTools } from './tools/skillAdmin.js';
import { initPacts } from '../pacts/index.js';

let initialized = false;

/** Registers every built-in tool and durable job handler. Idempotent. */
export function initAgent(): void {
  if (initialized) return;
  registerLocalTools();
  registerGmailTools();
  registerCalendarTools();
  registerNotifyTools();
  registerSkillAdminTools();
  registerAgentJobs();
  initPacts();
  initialized = true;
}
