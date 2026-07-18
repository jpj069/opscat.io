// Thin API client: cookie session + CSRF header, JSON errors as exceptions.
let csrfToken = '';
export function setCsrf(token: string) { csrfToken = token; }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['X-OpsCat-CSRF'] = csrfToken;
  const resp = await fetch(path, {
    method, headers, credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) throw new ApiError(resp.status, data?.error || `HTTP ${resp.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// SSE live stream with auto-reconnect.
export function openStream(handlers: { onLog?: (l: any) => void; onEvent?: (e: any) => void }): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    if (closed) return;
    es = new EventSource('/api/stream');
    es.addEventListener('log', (m) => { retry = 1000; handlers.onLog?.(JSON.parse((m as MessageEvent).data)); });
    es.addEventListener('event', (m) => { retry = 1000; handlers.onEvent?.(JSON.parse((m as MessageEvent).data)); });
    es.onerror = () => {
      es?.close();
      if (!closed) setTimeout(connect, retry = Math.min(retry * 2, 15000));
    };
  };
  connect();
  return () => { closed = true; es?.close(); };
}
