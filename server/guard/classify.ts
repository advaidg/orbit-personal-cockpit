import { insideProject, isProtectedWrite, isSecretPath, mentionsSecret, resolvePath } from './paths.js';
import { parseSegment, splitCommand, type Parsed } from './shell.js';
import type { Classification, Strictness, Verdict } from './types.js';

/**
 * Severity before the owner's strictness is applied:
 *  deny  – catastrophic, never worth a prompt
 *  ask   – needs the owner (destructive, deploys, secrets, leaves the machine)
 *  soft  – not known to be safe, not known to be dangerous
 *  allow – known safe
 */
type Severity = 'deny' | 'ask' | 'soft' | 'allow';
interface Finding { severity: Severity; reasons: string[]; category: string }

const RANK: Record<Severity, number> = { allow: 0, soft: 1, ask: 2, deny: 3 };
const found = (severity: Severity, category: string, ...reasons: string[]): Finding => ({ severity, category, reasons });

/** Programs that only look at things. */
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'whoami', 'date', 'uname', 'stat', 'file', 'tree', 'diff', 'sort', 'uniq', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'rg', 'fd', 'basename', 'dirname', 'realpath', 'readlink', 'du', 'df', 'ps', 'id', 'hostname', 'true', 'false', 'test', '[', 'cd', 'pushd', 'popd', 'sleep', 'jq', 'yq', 'less', 'more', 'column', 'nl', 'tac', 'rev', 'md5sum', 'shasum', 'sha256sum', 'cmp', 'comm', 'seq', 'expr', 'type', 'nproc', 'lsof', 'ag', 'bat', 'exa', 'eza', 'xxd', 'od', 'strings']);

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'whatchanged', 'grep', 'ls-tree', 'cat-file', 'rev-list', 'reflog', 'config --get', 'version', 'help', 'check-ignore', 'name-rev', 'merge-base', 'diff-tree', 'show-ref', 'for-each-ref']);
const BUILD_TEST = /^(test|lint|build|typecheck|type-check|check|format|fmt|coverage|tsc|vitest|jest|e2e|test:\w+|lint:\w+|check:\w+|build:\w+)$/;

function gitFinding(args: string[]): Finding {
  const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
  const rest = args.slice(args.indexOf(sub) + 1);
  const flags = args.filter((arg) => arg.startsWith('-'));
  if (GIT_READ.has(sub)) return found('allow', 'read');
  if (sub === 'branch') return rest.some((arg) => /^-[dD]$|^--delete$/.test(arg)) || flags.some((flag) => /^-[dD]$/.test(flag)) ? found('ask', 'delete', 'Deletes a git branch') : found('allow', 'read');
  if (sub === 'tag') return flags.some((flag) => /^-d$/.test(flag)) ? found('ask', 'delete', 'Deletes a git tag') : found('soft', 'git');
  if (sub === 'remote') return rest[0] === 'add' || rest[0] === 'set-url' || rest[0] === 'remove' || rest[0] === 'rm' ? found('ask', 'git', 'Changes where this repository pushes to') : found('allow', 'read');
  if (sub === 'stash') return rest[0] === 'drop' || rest[0] === 'clear' ? found('ask', 'delete', 'Throws away stashed work') : rest[0] === 'list' || rest[0] === 'show' ? found('allow', 'read') : found('soft', 'git');
  if (sub === 'push') {
    const force = flags.some((flag) => /^(-f|--force|--force-with-lease(=.*)?|--mirror|--delete|-d)$/.test(flag)) || rest.some((arg) => /^\+/.test(arg));
    const protectedBranch = rest.some((arg) => /(^|[:/])(main|master|production|prod|release)$/.test(arg));
    const reasons = [force ? 'Force-pushes, which can rewrite shared history' : '', protectedBranch ? 'Pushes to a protected branch' : ''].filter(Boolean);
    return reasons.length ? found('ask', 'push', ...reasons) : found('soft', 'push');
  }
  if (sub === 'reset' && flags.includes('--hard')) return found('ask', 'delete', 'Discards uncommitted changes (git reset --hard)');
  if (sub === 'clean') return flags.some((flag) => /f/.test(flag.replace(/^-+/, '')) || flag === '--force') ? found('ask', 'delete', 'Deletes untracked files (git clean)') : found('soft', 'git');
  if (sub === 'checkout' || sub === 'restore') return rest.includes('.') || flags.includes('--force') || flags.includes('-f') ? found('ask', 'delete', 'Throws away local changes') : found('soft', 'git');
  if (sub === 'filter-branch' || sub === 'filter-repo') return found('ask', 'delete', 'Rewrites the whole history');
  if (['add', 'commit', 'switch', 'fetch', 'pull', 'merge', 'rebase', 'cherry-pick', 'init', 'clone', 'worktree', 'revert', 'mv', 'rm', 'apply', 'am', 'bisect', 'submodule', 'config'].includes(sub)) {
    return sub === 'rm' ? found('ask', 'delete', 'Deletes tracked files') : found('allow', 'git');
  }
  return found('soft', 'git');
}

function packageFinding(bin: string, args: string[]): Finding {
  const sub = args[0] ?? '';
  const second = args[1] ?? '';
  if (['publish', 'unpublish', 'deprecate', 'owner', 'access', 'login', 'adduser', 'token'].includes(sub)) return found('ask', 'deploy', `Runs ${bin} ${sub}, which changes your published packages or credentials`);
  if (bin === 'npx' || bin === 'bunx' || bin === 'pnpx') {
    return /^(tsc|vitest|jest|eslint|prettier|tsx|ts-node|playwright|vite|next|astro|turbo|nx|biome|knip|depcheck|rimraf)$/.test(sub.replace(/@.*$/, '')) ? found('allow', 'dev') : found('soft', 'install');
  }
  if (['install', 'i', 'add', 'ci', 'update', 'upgrade', 'remove', 'rm', 'uninstall', 'link', 'dlx', 'create', 'init'].includes(sub)) {
    const named = args.slice(1).some((arg) => !arg.startsWith('-'));
    if (sub === 'ci' || ((sub === 'install' || sub === 'i') && !named)) return found('allow', 'dev');
    return found('soft', 'install', `Installs or changes a dependency (${bin} ${sub})`);
  }
  if (sub === 'run' || sub === 'run-script') return BUILD_TEST.test(second) ? found('allow', 'dev') : found('soft', 'dev');
  if (BUILD_TEST.test(sub) || ['start', 'dev', 'ls', 'list', 'outdated', 'audit', 'why', 'view', 'info', 'pack', 'exec', '-v', '--version', 'prefix', 'root', 'bin'].includes(sub)) return sub === 'exec' ? found('soft', 'dev') : found('allow', 'dev');
  return found('soft', 'dev');
}

const SQL_DESTRUCTIVE = /\b(?:drop\s+(?:table|database|schema|index|user|role)|truncate\s+(?:table\s+)?\w|delete\s+from\s+\w+\s*(?:;|$|"|')|alter\s+table\s+\w+\s+drop)/i;
const DEPLOYERS: Array<[RegExp, string]> = [
  [/^(vercel|netlify|surge|wrangler|firebase)$/, 'Deploys or changes a hosted service'],
  [/^(railway|fly|flyctl|heroku|render|serverless|sls|cdk|pulumi|amplify|supabase)$/, 'Deploys or changes a hosted service']
];

function binaryFinding(parsed: Parsed): Finding {
  const { bin, args } = parsed;
  const lowered = bin.toLowerCase();
  const joined = args.join(' ');

  if (lowered === 'rm' || lowered === 'rmdir' || lowered === 'unlink' || lowered === 'shred' || lowered === 'trash') {
    const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
    const targets = args.filter((arg) => !arg.startsWith('-'));
    const catastrophic = targets.some((target) => /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\.\.?\/?|\*|\/(usr|etc|bin|boot|var|lib|home|Users|System)(\/\*?)?)$/.test(target));
    if (recursive && catastrophic) return found('deny', 'delete', 'Would erase a system or home directory');
    if (recursive || args.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === '--force')) return found('ask', 'delete', 'Deletes files that cannot be recovered');
    return found('ask', 'delete', 'Deletes files');
  }
  if (lowered === 'mkfs' || lowered.startsWith('mkfs.') || lowered === 'fdisk' || lowered === 'parted' || lowered === 'wipefs' || lowered === 'diskutil' && /erase|partition|repair/i.test(joined)) return found('deny', 'delete', 'Formats or repartitions a disk');
  if (lowered === 'dd' && /\bof=\/dev\//.test(joined)) return found('deny', 'delete', 'Writes directly to a disk device');
  if (lowered === ':' || /:\(\)\s*\{/.test(`${bin} ${joined}`)) return found('deny', 'delete', 'Looks like a fork bomb');

  if (READ_ONLY.has(lowered)) return found('allow', 'read');
  if (lowered === 'find') return /(^| )-(delete|exec|execdir|ok|fprint|fls)\b/.test(joined) ? found('ask', 'delete', 'find that deletes or runs commands on what it finds') : found('allow', 'read');
  if (lowered === 'sed') return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place') ? found('soft', 'write') : found('allow', 'read');
  if (lowered === 'awk' || lowered === 'gawk') return /system\s*\(|\|\s*getline|print\s*>/.test(joined) ? found('soft', 'unknown') : found('allow', 'read');
  if (lowered === 'env' || lowered === 'printenv') return found('ask', 'secrets', 'Prints environment variables, which often hold secrets');
  if (lowered === 'git') return gitFinding(args);
  if (/^(npm|pnpm|yarn|bun|npx|bunx|pnpx|deno|corepack)$/.test(lowered)) return packageFinding(lowered, args);
  if (lowered === 'node' || lowered === 'tsx' || lowered === 'ts-node' || lowered === 'python' || lowered === 'python3' || lowered === 'ruby' || lowered === 'php' || lowered === 'perl') {
    if (args.length === 1 && /^(-v|--version)$/.test(args[0])) return found('allow', 'read');
    return found('soft', 'run', 'Runs a script');
  }
  if (/^(tsc|vitest|jest|eslint|prettier|pytest|mocha|ava|playwright|biome|ruff|black|mypy|flake8|rubocop|rspec|phpunit)$/.test(lowered)) return found('allow', 'dev');
  if (lowered === 'cargo') return /^(publish|login|yank|owner)$/.test(args[0] ?? '') ? found('ask', 'deploy', `cargo ${args[0]} changes your published crates`) : /^(check|test|build|clippy|fmt|doc|tree|metadata|run|bench|fetch|clean|add|update)$/.test(args[0] ?? '') ? found('allow', 'dev') : found('soft', 'dev');
  if (lowered === 'go') return /^(test|build|vet|fmt|list|mod|run|generate|doc|version|env|get|install)$/.test(args[0] ?? '') ? found('allow', 'dev') : found('soft', 'dev');
  if (lowered === 'make' || lowered === 'just' || lowered === 'task') return /^(test|lint|build|check|fmt|format|typecheck|all|dev|install|clean)?$/.test(args[0] ?? '') ? found('allow', 'dev') : found('soft', 'dev');
  if (lowered === 'pip' || lowered === 'pip3' || lowered === 'uv' || lowered === 'poetry' || lowered === 'pipx' || lowered === 'conda' || lowered === 'brew' || lowered === 'apt' || lowered === 'apt-get' || lowered === 'dnf' || lowered === 'yum' || lowered === 'apk' || lowered === 'gem' || lowered === 'composer' || lowered === 'bundle' || lowered === 'mix') {
    if (/^(list|show|freeze|check|search|info|outdated|--version|-V|tree|config)$/.test(args[0] ?? '')) return found('allow', 'read');
    if (/^(publish|upload)$/.test(args[0] ?? '')) return found('ask', 'deploy', `${lowered} ${args[0]} changes your published packages`);
    return found('soft', 'install', `Installs or changes software (${lowered} ${args[0] ?? ''})`.trim());
  }
  if (lowered === 'twine') return found('ask', 'deploy', 'Uploads a package to a public index');
  if (lowered === 'docker' || lowered === 'podman' || lowered === 'docker-compose') {
    const sub = args[0] === 'compose' ? args[1] ?? '' : args[0] ?? '';
    if (/^(ps|images|logs|inspect|version|info|stats|top|port|diff|history|search|stack)$/.test(sub)) return found('allow', 'read');
    if (/^(push|login|logout)$/.test(sub)) return found('ask', 'deploy', `docker ${sub} sends images or credentials to a registry`);
    if (/^(rm|rmi|prune|kill|volume|system|network|container|image)$/.test(sub) && /(rm|prune|kill|-f|--force|-v)/.test(joined)) return found('ask', 'delete', 'Removes containers, images or volumes');
    if (/^(run|exec)$/.test(sub) && /--privileged|-v\s*\/:|--mount\s+type=bind,.*src=\/($|,)|--pid=host|--net(work)?=host/.test(joined)) return found('ask', 'dangerous', 'Runs a container with host-level access');
    return found('soft', 'run');
  }
  if (lowered === 'kubectl' || lowered === 'helm' || lowered === 'oc' || lowered === 'k9s') {
    if (/^(get|describe|logs|top|version|config|explain|api-resources|cluster-info|diff|template|lint|list|ls|status|history|show|search|repo)$/.test(args[0] ?? '')) return found('allow', 'read');
    return found('ask', 'deploy', `${lowered} ${args[0] ?? ''} changes a live cluster`.trim());
  }
  if (lowered === 'terraform' || lowered === 'tofu' || lowered === 'terragrunt') return /^(apply|destroy|import|taint|untaint|state|force-unlock|workspace)$/.test(args[0] ?? '') || /-auto-approve/.test(joined) ? found('ask', 'deploy', `${lowered} ${args[0] ?? ''} changes real infrastructure`.trim()) : found('allow', 'read');
  if (lowered === 'ansible-playbook' || lowered === 'ansible') return found('ask', 'deploy', 'Changes remote machines');
  if (lowered === 'aws' || lowered === 'gcloud' || lowered === 'az' || lowered === 'doctl' || lowered === 'ibmcloud' || lowered === 'oci') {
    return /\b(describe|list|get|show|ls|help|--version|sts get-caller-identity|whoami)\b/.test(joined) && !/\b(delete|remove|terminate|destroy|rm|purge|put|create|update|deploy|run-instances|stop|start|reboot|attach|detach)\b/.test(joined) ? found('allow', 'read') : found('ask', 'deploy', `Changes cloud resources (${lowered} ${args.slice(0, 2).join(' ')})`.trim());
  }
  for (const [pattern, reason] of DEPLOYERS) if (pattern.test(lowered)) return /^(whoami|status|logs|list|ls|help|--version|-v|version|info|inspect|domains|env ls)$/.test(args[0] ?? '') ? found('allow', 'read') : found('ask', 'deploy', reason);
  if (lowered === 'gh') {
    if (/^(pr|issue|run|workflow|release|repo|gist|label|project|cache|ruleset)$/.test(args[0] ?? '') && /^(view|list|status|checks|diff|download|watch|clone|checkout)$/.test(args[1] ?? '')) return found('allow', 'read');
    if (/^(auth|status|--version|search|browse)$/.test(args[0] ?? '')) return /^auth$/.test(args[0] ?? '') && /(login|token|refresh|setup-git)/.test(joined) ? found('ask', 'secrets', 'Changes or reveals GitHub credentials') : found('allow', 'read');
    if (/delete|archive|transfer|merge|close|--admin/.test(joined)) return found('ask', 'deploy', 'Changes a repository, pull request or release for other people');
    return found('soft', 'github', 'Changes something on GitHub');
  }
  if (lowered === 'curl' || lowered === 'wget' || lowered === 'http' || lowered === 'https' || lowered === 'xh') {
    const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)([:/]|$)/i;
    const upload = /(^| )(-d|--data(-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)|--post-data|--post-file|--method=(POST|PUT|PATCH|DELETE))\b/i.test(joined) || /^(post|put|patch|delete)$/i.test(args[0] ?? '');
    const targets = args.filter((arg) => /^https?:\/\//i.test(arg) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(arg));
    if (targets.length && targets.every((target) => local.test(target))) return found('allow', 'read');
    return upload ? found('ask', 'exfil', 'Sends data to an outside server') : found('soft', 'network', 'Contacts an outside server');
  }
  if (lowered === 'scp' || lowered === 'rsync' || lowered === 'sftp' || lowered === 'ftp' || lowered === 'ssh' || lowered === 'mosh' || lowered === 'nc' || lowered === 'ncat' || lowered === 'netcat' || lowered === 'socat' || lowered === 'telnet') return found('ask', 'exfil', lowered === 'ssh' || lowered === 'mosh' || lowered === 'telnet' ? 'Opens a session on another machine' : 'Copies or sends data to another machine');
  if (/^(sh|bash|zsh|fish|dash|ksh|eval|source|\.)$/.test(lowered)) return /^-c$/.test(args[0] ?? '') || lowered === 'eval' ? found('soft', 'run', 'Runs a command string') : found('soft', 'run', 'Runs a shell script');
  if (lowered === 'chmod' || lowered === 'chown' || lowered === 'chgrp' || lowered === 'setfacl') return /(^| )-[a-zA-Z]*R/.test(joined) || /\b(777|a\+rwx|\+s)\b/.test(joined) ? found('ask', 'dangerous', 'Changes permissions across many files') : found('soft', 'write');
  if (lowered === 'kill' || lowered === 'pkill' || lowered === 'killall') return found('soft', 'run', 'Stops running programs');
  if (lowered === 'su' || lowered === 'passwd' || lowered === 'visudo' || lowered === 'usermod' || lowered === 'useradd' || lowered === 'userdel' || lowered === 'sysctl' || lowered === 'mount' || lowered === 'umount' || lowered === 'iptables' || lowered === 'ufw' || lowered === 'systemctl' || lowered === 'launchctl' || lowered === 'crontab' || lowered === 'shutdown' || lowered === 'reboot' || lowered === 'halt' || lowered === 'defaults' && /write|delete/.test(joined)) return found('ask', 'dangerous', 'Changes system settings or services');
  if (lowered === 'psql' || lowered === 'mysql' || lowered === 'mariadb' || lowered === 'sqlite3' || lowered === 'mongosh' || lowered === 'mongo' || lowered === 'redis-cli' || lowered === 'pg_restore' || lowered === 'dropdb' || lowered === 'mongorestore') {
    if (lowered === 'dropdb' || /\b(flushall|flushdb|FLUSHALL|FLUSHDB|dropDatabase|drop\(\))\b/.test(joined) || SQL_DESTRUCTIVE.test(joined)) return found('ask', 'delete', 'Deletes database data');
    if (/-c\s|--command|-e\s|--eval|\bselect\b/i.test(joined) && !/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(joined)) return found('allow', 'read');
    return found('soft', 'database', 'Talks to a database');
  }
  if (lowered === 'open' || lowered === 'xdg-open' || lowered === 'code' || lowered === 'cursor') return found('soft', 'run');
  if (lowered === 'touch' || lowered === 'mkdir' || lowered === 'cp' || lowered === 'mv' || lowered === 'ln' || lowered === 'tee' || lowered === 'install' || lowered === 'patch' || lowered === 'truncate') return found('soft', 'write');
  if (lowered === 'tar' || lowered === 'zip' || lowered === 'unzip' || lowered === 'gzip' || lowered === 'gunzip' || lowered === '7z') return /(^| )-[a-zA-Z]*c|^[a-z]*c[a-z]*$|zip$/.test(`${args[0] ?? ''} ${bin}`) ? found('soft', 'write') : found('allow', 'read');
  if (lowered === '') return found('allow', 'read');
  return found('soft', 'unknown', `Runs “${lowered}”, which Orbit doesn't recognise`);
}

/** Rates one segment, including the files it touches and anything it pipes secrets into. */
/** Tricks that hide what a command really does from anyone (or anything) reading it. */
const OBFUSCATED = /\$\{?IFS\b|base64\s+(?:-d|--decode|-D)|\\x[0-9a-fA-F]{2}|\$'[^']*\\[0-7xu]|\bxxd\s+-r\b|\bprintf\s+['"][^'"]*\\[0-7x]|\beval\s+"?\$\(/;

function segmentFinding(segment: string, cwd: string | undefined): Finding {
  if (segment === '__obfuscated__') return found('ask', 'dangerous', 'The command is written to hide what it does');
  if (segment === '__pipe_to_shell__') return found('ask', 'dangerous', 'Runs downloaded or generated code directly');
  const parsed = parseSegment(segment);
  let finding = binaryFinding(parsed);
  const extra: Finding[] = [];
  if (parsed.wrappers.includes('sudo') || parsed.wrappers.includes('doas')) extra.push(found('ask', 'dangerous', 'Runs with administrator rights'));
  if (mentionsSecret(segment)) extra.push(found('ask', 'secrets', 'Touches a file that usually holds secrets'));
  if (SQL_DESTRUCTIVE.test(segment) && finding.category !== 'delete') extra.push(found('ask', 'delete', 'Contains SQL that deletes data'));
  if (/^(sh|bash|zsh|dash|ksh|fish)$/.test(parsed.bin) && parsed.args.some((arg) => /^-[a-z]*c$/.test(arg))) {
    const script = parsed.args[parsed.args.findIndex((arg) => /^-[a-z]*c$/.test(arg)) + 1];
    if (script) extra.push(classifyBash(script, cwd));
  } else if (parsed.bin === 'eval' && parsed.args.length) extra.push(classifyBash(parsed.args.join(' '), cwd));
  for (const target of parsed.redirects) extra.push(pathFinding(target, cwd, true));
  // Commands that take file arguments: judge what they would read or change.
  if (['cp', 'mv', 'tee', 'touch', 'mkdir', 'ln', 'install', 'truncate', 'patch'].includes(parsed.bin.toLowerCase())) {
    for (const arg of parsed.args.filter((value) => !value.startsWith('-'))) extra.push(pathFinding(arg, cwd, true));
  } else if (parsed.bin.toLowerCase() === 'cat' || parsed.bin.toLowerCase() === 'head' || parsed.bin.toLowerCase() === 'tail') {
    for (const arg of parsed.args.filter((value) => !value.startsWith('-'))) extra.push(pathFinding(arg, cwd, false));
  }
  for (const candidate of extra) if (RANK[candidate.severity] > RANK[finding.severity]) finding = { severity: candidate.severity, category: candidate.category, reasons: [...candidate.reasons, ...finding.reasons.filter((reason) => !candidate.reasons.includes(reason))] };
  else if (RANK[candidate.severity] === RANK[finding.severity] && candidate.reasons.length) finding = { ...finding, reasons: [...new Set([...finding.reasons, ...candidate.reasons])] };
  return finding;
}

/** Judges a file path for reading or changing. */
export function pathFinding(target: string, cwd: string | undefined, write: boolean): Finding {
  const resolved = resolvePath(target, cwd);
  if (!resolved) return found('allow', 'read');
  if (isSecretPath(resolved)) return found('ask', 'secrets', write ? 'Changes a file that holds secrets' : 'Reads a file that holds secrets');
  if (write && isProtectedWrite(resolved)) return found('ask', 'dangerous', 'Changes a file that alters how commands run (CI, shell, git or agent settings)');
  if (write && !insideProject(resolved, cwd)) return found('ask', 'write', 'Writes outside the project folder');
  return found(write ? 'allow' : 'allow', write ? 'write' : 'read');
}

/** Classifies a shell command line by its worst part. */
export function classifyBash(command: string, cwd: string | undefined): Finding {
  const trimmed = command.trim();
  if (!trimmed) return found('allow', 'read');
  const segments = splitCommand(trimmed);
  if (/\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python3?|node|ruby|perl)\b/.test(trimmed)) segments.push('__pipe_to_shell__');
  if (OBFUSCATED.test(trimmed)) segments.push('__obfuscated__');
  if (!segments.length) return found('soft', 'unknown', 'An empty or unreadable command');
  let worst: Finding = found('allow', 'read');
  const reasons = new Set<string>();
  for (const segment of segments) {
    const finding = segmentFinding(segment, cwd);
    finding.reasons.forEach((reason) => reasons.add(reason));
    if (RANK[finding.severity] > RANK[worst.severity]) worst = finding;
  }
  return { ...worst, reasons: [...reasons].filter(Boolean).slice(0, 4) };
}

const INTERNAL = new Set(['Task', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillShell', 'KillBash', 'SlashCommand', 'Skill', 'ToolSearch', 'Monitor', 'ScheduleWakeup']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'LSP']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ToolCall { tool: string; input: Record<string, unknown>; cwd?: string }

/** Rates any tool call, before the owner's strictness and rules are applied. */
export function rate(call: ToolCall): Finding {
  const { tool, input, cwd } = call;
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  if (tool === 'Bash' || tool === 'BashTool') return classifyBash(text('command'), cwd);
  if (READ_TOOLS.has(tool)) return pathFinding(text('file_path') || text('path') || text('notebook_path') || '.', cwd, false);
  if (WRITE_TOOLS.has(tool)) return pathFinding(text('file_path') || text('path') || text('notebook_path'), cwd, true);
  if (INTERNAL.has(tool)) return found('allow', 'internal');
  if (tool === 'WebSearch') return found('allow', 'read');
  if (tool === 'WebFetch') return found('soft', 'network', 'Fetches an outside page');
  if (tool.startsWith('mcp__')) return found('soft', 'mcp', `Calls an extension tool (${tool.replace(/^mcp__/, '').replace(/__/g, ' › ')})`);
  return found('soft', 'unknown', `Uses “${tool}”, which Orbit doesn't recognise`);
}

/** Turns a rating into what Orbit tells the agent, according to how strict the owner wants to be. */
export function applyStrictness(severity: Severity, strictness: Strictness): Verdict {
  if (severity === 'deny') return 'deny';
  if (severity === 'ask') return 'ask';
  if (severity === 'allow') return 'allow';
  return strictness === 'relaxed' ? 'allow' : strictness === 'strict' ? 'ask' : 'defer';
}

export function classify(call: ToolCall, strictness: Strictness): Classification {
  const finding = rate(call);
  return { verdict: applyStrictness(finding.severity, strictness), reasons: finding.reasons, category: finding.category };
}
