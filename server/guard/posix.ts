/**
 * The few POSIX path operations the classifier needs, written out so it has no Node dependency. That lets the
 * same code run on the server and in the browser playground.
 */
export const isAbsolute = (value: string): boolean => value.startsWith('/');

export function normalize(value: string): string {
  const absolute = isAbsolute(value);
  const out: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

export const join = (base: string, relative: string): string => normalize(`${base}/${relative}`);
export const basename = (value: string): string => value.replace(/\/+$/, '').split('/').pop() ?? '';
