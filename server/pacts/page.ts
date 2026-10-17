import type { PactAction, PublicPact } from './types.js';

const esc = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'no date set');

interface Choice {
  action: PactAction;
  label: string;
  hint: string;
  tone: 'primary' | 'plain' | 'quiet';
  needsDate?: boolean;
}

/** What the person on the link can do, in words that fit the side they are on. */
export function choices(pact: PublicPact): Choice[] {
  if (pact.role === 'doer') {
    return [
      { action: 'confirm', label: pact.confirmed ? 'You said you are on it' : 'I’m on it', hint: 'Lets them stop wondering.', tone: pact.confirmed ? 'plain' : 'primary' },
      { action: 'done', label: 'It’s done', hint: 'Closes this and tells them.', tone: 'primary' },
      { action: 'reschedule', label: 'I need more time', hint: 'Pick the date you can really do.', tone: 'plain', needsDate: true },
      { action: 'decline', label: 'I can’t do this', hint: 'Better to say so now.', tone: 'quiet' }
    ];
  }
  return [
    { action: 'confirm', label: pact.confirmed ? 'You said this is right' : 'This is right', hint: 'They described it correctly.', tone: pact.confirmed ? 'plain' : 'primary' },
    { action: 'done', label: 'I got it', hint: 'Closes this and tells them.', tone: 'primary' },
    { action: 'reschedule', label: 'Change the date', hint: 'They decide whether to move it.', tone: 'plain', needsDate: true },
    { action: 'cancel', label: 'No longer needed', hint: 'Closes this without anyone doing it.', tone: 'quiet' }
  ];
}

const STYLE = `
:root{--paper:#f6f1e7;--ink:#1d1a16;--muted:#6f675b;--line:#d9cfbd;--accent:#b4411f;--accent-ink:#fff7ee;--ok:#2f6b4f;--card:#fffdf8}
@media(prefers-color-scheme:dark){:root{--paper:#16130f;--ink:#f1eadc;--muted:#a79d8c;--line:#352f26;--accent:#e2744d;--accent-ink:#1b0e07;--ok:#7bc4a0;--card:#1e1a14}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.5 Georgia,'Iowan Old Style','Times New Roman',serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 16px 40px}
main{width:100%;max-width:520px}
.mark{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:0 0 22px;display:flex;align-items:center;gap:8px}
.mark i{width:9px;height:9px;border-radius:50%;background:var(--accent);display:inline-block;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
h1{font-size:clamp(28px,7vw,38px);line-height:1.08;margin:0 0 14px;letter-spacing:-.01em;font-weight:700}
.promise{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:4px 14px 14px 4px;padding:18px 20px;margin:0 0 20px}
.promise p{margin:0;font-size:20px;line-height:1.35}
.promise small{display:block;margin-top:10px;color:var(--muted);font:14px/1.4 ui-sans-serif,system-ui,sans-serif}
.state{font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--ok);margin:0 0 16px}
.state.closed{color:var(--muted)}
form{display:grid;gap:10px;margin:0}
.opt{display:block;width:100%;text-align:left;border:1.5px solid var(--line);background:var(--card);color:var(--ink);border-radius:12px;padding:14px 16px;font:inherit;cursor:pointer;min-height:56px;transition:transform .12s ease,border-color .12s ease,background .12s ease}
.opt:hover,.opt:focus-visible{border-color:var(--accent);transform:translateY(-1px);outline:none}
.opt:active{transform:translateY(0)}
.opt.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.opt.quiet{background:transparent}
.opt b{display:block;font:600 16px/1.3 ui-sans-serif,system-ui,sans-serif}
.opt span{display:block;font:14px/1.35 ui-sans-serif,system-ui,sans-serif;opacity:.78;margin-top:2px}
details{border:1.5px solid var(--line);border-radius:12px;background:var(--card);padding:0}
summary{list-style:none;cursor:pointer;padding:14px 16px;min-height:56px}
summary::-webkit-details-marker{display:none}
summary b{display:block;font:600 16px/1.3 ui-sans-serif,system-ui,sans-serif}
summary span{display:block;font:14px/1.35 ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin-top:2px}
details[open] summary{border-bottom:1px solid var(--line)}
.more{display:grid;gap:10px;padding:14px 16px 16px}
label{font:600 13px/1.2 ui-sans-serif,system-ui,sans-serif;color:var(--muted);display:grid;gap:6px}
input,textarea{font:16px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--paper);border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;width:100%}
input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.go{border:0;background:var(--ink);color:var(--paper);font:600 15px/1 ui-sans-serif,system-ui,sans-serif;border-radius:10px;padding:14px;cursor:pointer;min-height:48px}
.note{margin-top:6px}
.thanks{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px}
.thanks strong{display:block;font-size:20px;margin-bottom:4px}
footer{margin-top:34px;padding-top:16px;border-top:1px dashed var(--line);color:var(--muted);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
footer a{color:var(--ink)}
@media(prefers-reduced-motion:reduce){.opt{transition:none}.opt:hover{transform:none}}
`;

function shell(title: string, body: string, repoUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><p class="mark"><i></i>Orbit pact</p>${body}<footer>This page is one person’s private tracker for a promise. It has no account, no ads and no tracking. Orbit is open source and anyone can run their own copy — <a href="${esc(repoUrl)}" rel="noopener noreferrer">see how</a>.</footer></main></body></html>`;
}

export function notFoundPage(repoUrl: string): string {
  return shell('Link not available', `<h1>This link isn’t working.</h1><div class="thanks"><strong>It may have expired or been replaced.</strong>Ask the person who sent it for a new one. Nothing was changed.</div>`, repoUrl);
}

function sentence(pact: PublicPact): string {
  const due = pact.dueAt ? ` by ${day(pact.dueAt)}` : '';
  return pact.role === 'doer' ? `${esc(pact.ownerName)} is counting on you to <b>${esc(pact.action)}</b>${due}.` : `${esc(pact.ownerName)} will <b>${esc(pact.action)}</b>${due}.`;
}

export interface PageState {
  pact: PublicPact;
  repoUrl: string;
  /** Result of the last action, shown once after redirect. */
  thanks?: string;
  error?: string;
}

export function pactPage(state: PageState): string {
  const { pact } = state;
  const closed = pact.status !== 'open';
  const heading = closed ? (pact.status === 'done' ? 'All done.' : 'This one is closed.') : pact.role === 'doer' ? `Hi ${esc(pact.otherPerson.split(' ')[0])}, quick check-in.` : `${esc(pact.ownerName)} is keeping a promise to you.`;
  const status = closed ? `<p class="state closed">Closed — ${esc(pact.status)}.</p>` : pact.confirmed ? '<p class="state">Confirmed.</p>' : '';
  const requested = pact.requestedDueAt && pact.role === 'requester' ? `<p class="state">You asked for ${esc(day(pact.requestedDueAt))}. ${esc(pact.ownerName)} will see it.</p>` : '';
  const thanks = state.thanks ? `<div class="thanks" role="status"><strong>${esc(state.thanks)}</strong>${esc(pact.ownerName)} has been told.</div>` : '';
  const error = state.error ? `<div class="thanks" role="alert"><strong>${esc(state.error)}</strong>Nothing was changed.</div>` : '';
  const forms = closed ? '' : `<form method="post" autocomplete="off">${choices(pact).map((choice) => option(choice)).join('')}<details class="note"><summary><b>Add a note</b><span>Optional. ${esc(pact.ownerName)} will read it.</span></summary><div class="more"><label>Note<textarea name="note" maxlength="280" rows="3"></textarea></label><span style="font:13px ui-sans-serif,system-ui,sans-serif;color:var(--muted)">It goes with whichever button you press.</span></div></details></form>`;
  const body = `<h1>${heading}</h1>${error}${thanks}<div class="promise"><p>${sentence(pact)}</p><small>${pact.dueAt ? `Due ${esc(day(pact.dueAt))}` : 'No date set'}${pact.expiresAt ? ` · link works until ${esc(day(pact.expiresAt))}` : ''}</small></div>${status}${requested}${forms}`;
  return shell(`${pact.ownerName}’s pact`, body, state.repoUrl);
}

function option(choice: Choice): string {
  if (!choice.needsDate) return `<button class="opt ${choice.tone}" type="submit" name="action" value="${choice.action}"><b>${esc(choice.label)}</b><span>${esc(choice.hint)}</span></button>`;
  return `<details><summary><b>${esc(choice.label)}</b><span>${esc(choice.hint)}</span></summary><div class="more"><label>New date<input type="date" name="date"></label><button class="go" type="submit" name="action" value="${choice.action}">Send</button></div></details>`;
}
