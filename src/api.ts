export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly action?: string, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status})`, response.status, data.action, data.code);
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>('GET', url),
  post: <T,>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T,>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T,>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T = void,>(url: string, body?: unknown) => request<T>('DELETE', url, body)
};

/** Turns any thrown value into one readable sentence plus an optional next step. */
export function describeError(error: unknown): { message: string; action?: string } {
  if (error instanceof ApiError) return { message: error.message, action: error.action };
  return { message: error instanceof Error ? error.message : 'Something went wrong' };
}
