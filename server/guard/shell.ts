/**
 * Just enough shell understanding to judge a command line safely: split it into the commands it would run
 * (so `ls && rm -rf x` is judged by its worst part), pull out command substitutions, and find redirections.
 * It is deliberately conservative: anything it cannot make sense of is treated as unknown, never as safe.
 */

/** Splits on ; && || | & and newlines outside quotes, and appends the contents of $(...) and `...` as extra commands. */
export function splitCommand(input: string, depth = 0): string[] {
  const segments: string[] = [];
  const extras: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const text = input.replace(/\r/g, '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && quote !== "'") {
      current += char + (text[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === '$' && text[index + 1] === '(') {
        const inner = readParen(text, index + 1);
        extras.push(inner.body);
      } else if (quote === '"' && char === '`') {
        const end = text.indexOf('`', index + 1);
        if (end > index) { extras.push(text.slice(index + 1, end)); }
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '$' && text[index + 1] === '(') {
      const inner = readParen(text, index + 1);
      extras.push(inner.body);
      current += text.slice(index, inner.end + 1);
      index = inner.end;
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index) { extras.push(text.slice(index + 1, end)); current += text.slice(index, end + 1); index = end; continue; }
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      // `2>&1` and `>&2` are redirections, not command separators.
      if (char === '&' && (text[index - 1] === '>' || text[index - 1] === '<' || text[index + 1] === '>')) { current += char; continue; }
      if ((char === '|' || char === '&') && text[index + 1] === char) index += 1;
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  if (depth < 3) for (const extra of extras) segments.push(...splitCommand(extra, depth + 1));
  return segments;
}

function readParen(text: string, openIndex: number): { body: string; end: number } {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, index), end: index };
    }
  }
  return { body: text.slice(openIndex + 1), end: text.length - 1 };
}

/** Splits one command into words, honouring quotes. Quote characters are removed. */
export function words(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === '\\' && quote !== "'" && index + 1 < segment.length) { current += segment[index + 1]; index += 1; started = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { out.push(current); current = ''; started = false; } continue; }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

const WRAPPERS = new Set(['sudo', 'doas', 'time', 'nohup', 'env', 'command', 'exec', 'nice', 'ionice', 'xargs', 'timeout', 'stdbuf', 'builtin']);

export interface Parsed {
  /** The program being run, after wrappers and VAR=value prefixes are removed. */
  bin: string;
  args: string[];
  /** Wrappers that were stripped, such as sudo. */
  wrappers: string[];
  /** Files the command writes with > or >>. */
  redirects: string[];
}

/** Reduces one command to its program and arguments. */
export function parseSegment(segment: string): Parsed {
  const all = words(segment);
  const redirects: string[] = [];
  const kept: string[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const word = all[index];
    const match = /^(\d*)(>>?|&>>?)(.*)$/.exec(word);
    if (match) {
      const target = match[3] || all[index + 1] || '';
      if (!match[3]) index += 1;
      if (!/^&\d$/.test(target) && target !== '/dev/null') redirects.push(target);
      continue;
    }
    kept.push(word);
  }
  const wrappers: string[] = [];
  let rest = kept;
  for (;;) {
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    if (rest.length && WRAPPERS.has(rest[0].replace(/^.*\//, ''))) {
      wrappers.push(rest[0].replace(/^.*\//, ''));
      rest = rest.slice(1);
      // Skip the wrapper's own flags, and the duration argument of `timeout`.
      while (rest.length && /^-/.test(rest[0])) rest = rest.slice(1);
      if (wrappers[wrappers.length - 1] === 'timeout' && rest.length && /^\d/.test(rest[0])) rest = rest.slice(1);
      continue;
    }
    break;
  }
  // A bare `env` prints the environment; it is a program here, not a wrapper.
  if (!rest.length && wrappers[wrappers.length - 1] === 'env') return { bin: 'env', args: [], wrappers: wrappers.slice(0, -1), redirects };
  const first = rest[0] ?? '';
  return { bin: first.replace(/^.*\//, ''), args: rest.slice(1), wrappers, redirects };
}
