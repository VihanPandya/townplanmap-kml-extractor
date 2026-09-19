/**
 * Shared helpers for the API routes: consistent JSON envelopes, request
 * validation and error handling.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

export type ApiError = { error: string; detail?: string };

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: {
      // Catalog responses reflect live upstream state; never let a proxy serve
      // a stale one.
      'cache-control': 'no-store',
      ...init?.headers,
    },
  });
}

export function fail(status: number, error: string, detail?: string): NextResponse {
  return NextResponse.json({ error, ...(detail ? { detail } : {}) } satisfies ApiError, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Parse and validate a JSON body, returning a 400 response on failure. */
export async function readJson<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: fail(400, 'Request body must be valid JSON.') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      response: fail(
        400,
        'Request body failed validation.',
        first ? `${first.path.join('.') || 'body'}: ${first.message}` : undefined,
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

/** The context Next.js passes to a dynamic route handler. */
export type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

/**
 * Read a required path parameter.
 *
 * Next types route params loosely, and with `noUncheckedIndexedAccess` a
 * missing segment is a real possibility rather than a type-system nuisance, so
 * it is checked rather than asserted away.
 */
export async function pathParam(context: RouteContext, name: string): Promise<string | null> {
  const params = await context.params;
  const value = params[name];
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/** Wrap a handler so an unexpected throw becomes a 500 rather than a crash. */
export function handler(run: (request: Request, context: RouteContext) => Promise<Response>) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    try {
      return await run(request, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      // Log server-side; return the message, which is ours rather than a raw
      // upstream body.
      console.error('[api]', message);
      return fail(500, 'The request could not be completed.', message);
    }
  };
}

/** Common query-parameter readers. */
export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

export const exportScopeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('features'),
    layerId: z.string().min(1).max(200),
    featureIds: z.array(z.string().min(1).max(300)).min(1).max(100_000),
  }),
  z.object({ type: z.literal('layer'), layerId: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('location'),
    locationId: z.string().min(1).max(200),
    layerIds: z.array(z.string().min(1).max(200)).min(1).max(200),
  }),
  z.object({
    type: z.literal('combined'),
    layerIds: z.array(z.string().min(1).max(200)).min(1).max(200),
    featureIds: z.array(z.string().min(1).max(300)).max(100_000).optional(),
  }),
]);

export const exportRequestSchema = z.object({
  scope: exportScopeSchema,
  format: z.enum(['kml', 'kmz', 'geojson']).default('kml'),
  individualFiles: z.boolean().optional(),
  includeOriginals: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
});

/**
 * Accept the flatter request shape documented in the API section
 * (`{ layerId, featureIds, format }`) as well as the explicit scope form.
 */
export const flexibleExportSchema = z.union([
  exportRequestSchema,
  z
    .object({
      layerId: z.string().min(1).max(200),
      featureIds: z.array(z.string().min(1).max(300)).min(1).max(100_000).optional(),
      format: z.enum(['kml', 'kmz', 'geojson']).default('kml'),
      individualFiles: z.boolean().optional(),
      name: z.string().min(1).max(200).optional(),
    })
    .transform((input) => ({
      scope:
        input.featureIds && input.featureIds.length > 0
          ? ({ type: 'features', layerId: input.layerId, featureIds: input.featureIds } as const)
          : ({ type: 'layer', layerId: input.layerId } as const),
      format: input.format,
      individualFiles: input.individualFiles,
      name: input.name,
    })),
]);
