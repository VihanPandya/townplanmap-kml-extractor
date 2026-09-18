/**
 * The single outbound HTTP path for the whole application.
 *
 * Nothing else in the codebase calls `fetch` against a discovered URL. Every
 * request made here is validated against the SSRF rules, counted against a
 * budget, capped in size and time, and has its redirects followed manually so
 * each hop is re-validated instead of being trusted because the first hop was.
 */

import { LIMITS, USER_AGENT } from '@/lib/config';
import { assertSafeUrl } from './ssrf';
import { RequestBudget } from './budget';

export type FetchOutcome =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      bytes: number;
      body: Uint8Array;
      headers: Record<string, string>;
      truncated: boolean;
      elapsedMs: number;
      redirects: string[];
    }
  | {
      ok: false;
      url: string;
      status: number | null;
      /** Machine-readable failure class, for the UI to branch on. */
      kind: FetchFailureKind;
      reason: string;
      elapsedMs: number;
    };

export type FetchFailureKind =
  | 'blocked'        // rejected by our own safety rules
  | 'budget'         // request budget for this operation is spent
  | 'timeout'
  | 'network'
  | 'too-large'
  | 'http-error'     // upstream returned a non-2xx
  | 'auth-required'  // 401/403: needs authorised access upstream
  | 'rate-limited';  // 429: back off, do not evade

export type SafeFetchOptions = {
  budget: RequestBudget;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Overrides the global response cap for this one request. */
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  signal?: AbortSignal;
};

const HEADERS_TO_KEEP = [
  'content-type',
  'content-length',
  'content-disposition',
  'last-modified',
  'etag',
  'server',
  'x-powered-by',
  'access-control-allow-origin',
  'retry-after',
];

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADERS_TO_KEEP) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function classifyStatus(status: number): FetchFailureKind {
  if (status === 401 || status === 403) return 'auth-required';
  if (status === 429) return 'rate-limited';
  return 'http-error';
}

/**
 * Read a response body with a hard byte cap, aborting the transfer as soon as
 * the cap is passed rather than buffering an unbounded payload first.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  const declared = response.headers.get('content-length');
  if (declared) {
    const size = Number.parseInt(declared, 10);
    if (Number.isFinite(size) && size > maxBytes) {
      // Refuse before reading a single chunk.
      try {
        await response.body?.cancel();
      } catch {
        /* the socket is going away regardless */
      }
      throw new ResponseTooLargeError(size, maxBytes);
    }
  }

  if (!response.body) {
    return { body: new Uint8Array(0), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated: false };
}

export class ResponseTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`Response of ${size} bytes exceeds the ${limit} byte limit.`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Fetch a URL under every safety control the tool enforces.
 *
 * Redirects are followed by hand: `redirect: 'manual'` keeps undici from
 * chasing a Location header to an address we never validated, which is the
 * usual way an SSRF filter gets walked past.
 */
export async function safeFetch(target: string, options: SafeFetchOptions): Promise<FetchOutcome> {
  const started = Date.now();
  const maxBytes = Math.min(options.maxBytes ?? LIMITS.maxResponseBytes, LIMITS.maxResponseBytes);
  const timeoutMs = Math.min(options.timeoutMs ?? LIMITS.requestTimeoutMs, LIMITS.requestTimeoutMs);
  const redirects: string[] = [];

  let current = target;

  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
    const verdict = await assertSafeUrl(current);
    if (!verdict.ok) {
      return {
        ok: false,
        url: target,
        status: null,
        kind: 'blocked',
        reason: verdict.reason,
        elapsedMs: Date.now() - started,
      };
    }

    const url = verdict.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(new Error('cancelled'));
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await options.budget.spend(url.hostname, () =>
        fetch(url, {
          method: options.method ?? 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: options.accept ?? '*/*',
            'accept-language': 'en',
            ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: options.body } : {}),
        }),
      );

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        if (!location) {
          return {
            ok: false,
            url: target,
            status: response.status,
            kind: 'http-error',
            reason: `Redirect status ${response.status} with no Location header.`,
            elapsedMs: Date.now() - started,
          };
        }
        if (hop === LIMITS.maxRedirects) {
          return {
            ok: false,
            url: target,
            status: response.status,
            kind: 'blocked',
            reason: `Exceeded the ${LIMITS.maxRedirects} redirect limit.`,
            elapsedMs: Date.now() - started,
          };
        }
        const next = new URL(location, url).toString();
        redirects.push(next);
        current = next;
        continue; // Re-validate the new target at the top of the loop.
      }

      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          url: target,
          status: response.status,
          kind: classifyStatus(response.status),
          reason:
            response.status === 401 || response.status === 403
              ? 'This dataset requires authorised access through TownPlanMap.'
              : `Upstream responded ${response.status} ${response.statusText}.`,
          elapsedMs: Date.now() - started,
        };
      }

      const { body, truncated } = await readCapped(response, maxBytes);
      options.budget.recordBytes(body.byteLength);

      return {
        ok: true,
        url: target,
        finalUrl: url.toString(),
        status: response.status,
        contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
        bytes: body.byteLength,
        body,
        headers: pickHeaders(response.headers),
        truncated,
        elapsedMs: Date.now() - started,
        redirects,
      };
    } catch (error) {
      const elapsedMs = Date.now() - started;
      if (error instanceof ResponseTooLargeError) {
        return { ok: false, url: target, status: null, kind: 'too-large', reason: error.message, elapsedMs };
      }
      if (error instanceof Error && error.name === 'BudgetExceededError') {
        return { ok: false, url: target, status: null, kind: 'budget', reason: error.message, elapsedMs };
      }
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        url: target,
        status: null,
        kind: aborted ? 'timeout' : 'network',
        reason: aborted
          ? `Request timed out after ${timeoutMs} ms.`
          : error instanceof Error
            ? error.message
            : 'Network error.',
        elapsedMs,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    ok: false,
    url: target,
    status: null,
    kind: 'blocked',
    reason: 'Redirect limit exceeded.',
    elapsedMs: Date.now() - started,
  };
}

/** Decode a fetched body as UTF-8 text. */
export function asText(outcome: Extract<FetchOutcome, { ok: true }>): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(outcome.body);
}

/** Decode and JSON-parse a fetched body, returning null when it is not JSON. */
export function asJson<T = unknown>(outcome: Extract<FetchOutcome, { ok: true }>): T | null {
  try {
    return JSON.parse(asText(outcome)) as T;
  } catch {
    return null;
  }
}
