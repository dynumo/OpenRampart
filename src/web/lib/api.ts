/**
 * JSON API client. Adds the CSRF token to state-changing requests and the
 * selected record (for Helpers viewing someone else's record).
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly fields: Record<string, string> = {},
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

let csrfToken = '';
export function setCsrfToken(token: string | undefined) {
  csrfToken = token ?? '';
}

const RECORD_KEY = 'openrampart.record';
let recordOwner: string | null = (() => {
  try {
    return sessionStorage.getItem(RECORD_KEY);
  } catch {
    return null;
  }
})();

export function getRecordOwner(): string | null {
  return recordOwner;
}
export function setRecordOwner(ownerId: string | null) {
  recordOwner = ownerId;
  try {
    if (ownerId) sessionStorage.setItem(RECORD_KEY, ownerId);
    else sessionStorage.removeItem(RECORD_KEY);
  } catch {
    // storage unavailable
  }
}

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function headers(method: string, json: boolean): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (method !== 'GET') h['X-CSRF-Token'] = csrfToken || '1';
  if (recordOwner) h['X-OpenRampart-Record'] = recordOwner;
  return h;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: {
    error?: {
      code?: string;
      message?: string;
      fields?: Record<string, string>;
      retryAfterSeconds?: number;
    };
  } = {};
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const e = body.error ?? {};
  const message =
    e.message ??
    (res.status === 413
      ? 'That file is too large.'
      : res.status >= 500
        ? 'Something went wrong. Please try again.'
        : 'The request could not be completed.');
  return new ApiError(message, res.status, e.code ?? 'error', e.fields ?? {}, e.retryAfterSeconds);
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; base?: string } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const res = await fetch(`${opts.base ?? '/api'}${path}${qs(opts.query)}`, {
    method,
    credentials: 'same-origin',
    headers: headers(method, opts.body !== undefined),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Upload one file with progress reporting (XMLHttpRequest exposes upload progress). */
export function uploadFile<T>(
  path: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    for (const [k, v] of Object.entries(headers('POST', false))) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
      const e =
        (
          body as {
            error?: { message?: string; code?: string; fields?: Record<string, string> };
          } | null
        )?.error ?? {};
      reject(
        new ApiError(
          e.message ?? (xhr.status === 413 ? 'That file is too large.' : 'Upload failed'),
          xhr.status,
          e.code ?? 'error',
          e.fields ?? {},
        ),
      );
    };
    xhr.onerror = () =>
      reject(new ApiError('The connection was interrupted. Please try again.', 0, 'network'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export function attachmentUrl(
  id: string,
  variant: 'original' | 'thumbnail' | 'preview',
  download = false,
): string {
  // Images and documents are fetched by the browser directly (no custom headers), so a
  // Helper's selected record travels in the query string. The server authorises every request.
  return `/api/attachments/${id}/${variant}${qs({ download: download ? '1' : undefined, record: recordOwner ?? undefined })}`;
}

export function apiUrl(path: string, query?: Query): string {
  return `/api${path}${qs({ ...(query ?? {}), record: recordOwner ?? undefined })}`;
}
