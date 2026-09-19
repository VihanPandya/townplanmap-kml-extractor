/**
 * A routing stand-in for `safeFetch`, so provider code can be driven against
 * realistic wire formats without a socket.
 *
 * The SSRF-guarded fetcher itself is covered by `security.test.ts`; what these
 * tests exercise is everything above it — URL construction, pagination,
 * format fallback, parsing and error handling.
 */

import { vi } from 'vitest';
import type { FetchOutcome } from '@/lib/net/safe-fetch';

export type Route = {
  /** Matched against the full request URL. */
  match: (url: URL) => boolean;
  /** JSON body, XML/text body, or a failure. */
  respond: (url: URL) =>
    | { json: unknown; contentType?: string }
    | { text: string; contentType?: string }
    | { failure: Extract<FetchOutcome, { ok: false }>['kind']; reason?: string; status?: number };
};

export type RecordedRequest = { url: string; method: string; body?: string };

/** The slice of the real fetch options the recorder needs. */
export type MockFetchOptions = {
  method?: string;
  body?: string;
  budget: { spend: <T>(host: string, task: () => Promise<T>) => Promise<T> };
};

export class FetchRecorder {
  readonly requests: RecordedRequest[] = [];

  constructor(private routes: Route[]) {}

  /** URLs seen so far, for asserting on what the provider actually asked for. */
  get urls(): string[] {
    return this.requests.map((request) => request.url);
  }

  /** The query parameters of the nth request matching a substring. */
  paramsOf(substring: string, index = 0): URLSearchParams | null {
    const matches = this.requests.filter((request) => request.url.includes(substring));
    const found = matches[index];
    return found ? new URL(found.url).searchParams : null;
  }

  reset(): void {
    this.requests.length = 0;
  }

  readonly fetch = async (target: string, options: MockFetchOptions): Promise<FetchOutcome> => {
    this.requests.push({ url: target, method: options.method ?? 'GET', body: options.body });

    const url = new URL(target);
    const route = this.routes.find((candidate) => candidate.match(url));

    if (!route) {
      return {
        ok: false,
        url: target,
        status: 404,
        kind: 'http-error',
        reason: `No mock route matched ${target}`,
        elapsedMs: 1,
      };
    }

    // Spend the budget exactly as the real fetcher does, so budget exhaustion
    // and concurrency behave the same under test.
    return options.budget.spend(url.hostname, async () => {
      const result = route.respond(url);

      if ('failure' in result) {
        return {
          ok: false as const,
          url: target,
          status: result.status ?? null,
          kind: result.failure,
          reason: result.reason ?? 'mock failure',
          elapsedMs: 1,
        };
      }

      const body =
        'json' in result ? JSON.stringify(result.json) : result.text;
      const contentType =
        result.contentType ?? ('json' in result ? 'application/json' : 'text/xml');

      return {
        ok: true as const,
        url: target,
        finalUrl: target,
        status: 200,
        contentType,
        bytes: Buffer.byteLength(body, 'utf8'),
        body: new TextEncoder().encode(body),
        headers: { 'content-type': contentType },
        truncated: false,
        elapsedMs: 1,
        redirects: [],
      };
    });
  };
}

/**
 * Install a mock for the safe-fetch module.
 *
 * Must be called from a `vi.mock` factory at module scope, because vitest
 * hoists those above imports.
 */
export function createRecorder(routes: Route[]): FetchRecorder {
  return new FetchRecorder(routes);
}

/** Convenience matcher: the path ends with `suffix` (query string ignored). */
export function pathEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname.endsWith(suffix);
}

/** Convenience matcher: the path is exactly `path`. */
export function pathIs(path: string): (url: URL) => boolean {
  return (url) => url.pathname === path;
}

export { vi };
