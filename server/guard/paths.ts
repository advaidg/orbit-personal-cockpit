import path from 'node:path';

const HOME_MARK = '~';

/** Resolves a path the way the agent will: relative to its working directory, with ~ kept as a marker. */
export function resolvePath(value: string, cwd: string | undefined): string {
  const raw = value.trim();
  if (!raw) return '';
  if (raw === HOME_MARK || raw.startsWith(`${HOME_MARK}/`) || raw.startsWith('$HOME') || raw.startsWith('${HOME}')) return path.posix.normalize(raw.replace(/^\$\{?HOME\}?/, HOME_MARK));
  if (path.posix.isAbsolute(raw)) return path.posix.normalize(raw);
  return path.posix.normalize(path.posix.join(cwd && path.posix.isAbsolute(cwd) ? cwd : '/__unknown__', raw));
}

/** True when `target` is the project directory itself or inside it. */
export function insideProject(target: string, cwd: string | undefined): boolean {
  if (!cwd || !path.posix.isAbsolute(cwd)) return false;
  const base = path.posix.normalize(cwd).replace(/\/+$/, '');
  const resolved = resolvePath(target, cwd);
  return resolved === base || resolved.startsWith(`${base}/`);
}

/** Files that hold secrets or identity. Reading or changing them always needs the owner. */
const SECRET = [
  /(^|\/)\.env($|\.(?!example$|sample$|template$))/i,
  /(^|\/)\.ssh(\/|$)/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)\.aws(\/|$)/, /(^|\/)\.gcloud(\/|$)|(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.azure(\/|$)/, /(^|\/)\.kube\/config$/,
  /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)\.netrc$/, /(^|\/)\.pgpass$/, /(^|\/)\.git-credentials$/, /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.gnupg(\/|$)/, /(^|\/)(secrets?|credentials?)(\.[a-z0-9]+)?$/i, /(^|\/)\.config\/gh\/hosts\.yml$/,
  /^\/etc\/(shadow|sudoers|ssh\/)/, /^\/etc\/passwd$/, /(^|\/)Library\/Keychains(\/|$)/
];

/** Places a write could quietly change how future commands behave. */
const PROTECTED_WRITE = [
  /(^|\/)\.github\/workflows(\/|$)/, /(^|\/)\.git\/(hooks|config)(\/|$)?/, /(^|\/)\.(bash|zsh|fish)?(rc|_profile|profile)$/, /(^|\/)\.zshenv$/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/, /(^|\/)\.claude\/hooks(\/|$)/, /(^|\/)\.cursor\/(mcp|rules)/, /(^|\/)\.mcp\.json$/,
  /^\/(etc|usr|bin|sbin|boot|sys|proc|var\/lib|System|Library)(\/|$)/, /(^|\/)(crontab|authorized_keys|known_hosts)$/, /(^|\/)\.config\/systemd(\/|$)/, /(^|\/)Library\/LaunchAgents(\/|$)/
];

export const isSecretPath = (value: string): boolean => SECRET.some((pattern) => pattern.test(value));
export const isProtectedWrite = (value: string): boolean => PROTECTED_WRITE.some((pattern) => pattern.test(value));

/** Mentions of secret files inside a free-form command, for example `cat .env | curl ...`. */
export function mentionsSecret(command: string): boolean {
  return /(^|[\s='"/])\.env(?![\w.]*(example|sample|template))(\b|$|[\s'"])/i.test(command)
    || /\.ssh\/|id_(rsa|ed25519|ecdsa)|\.aws\/(credentials|config)|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.gnupg|\/etc\/(shadow|sudoers)|\.kube\/config|\.docker\/config\.json/.test(command);
}
