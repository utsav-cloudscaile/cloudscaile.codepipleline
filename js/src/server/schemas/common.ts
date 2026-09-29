/**
 * The response contracts every /v1 route follows — defined once so no route
 * invents its own shape:
 *
 * - Success: `{ success: true, data: <route-specific> }`
 * - Error:   `{ success: false, error: { code, message } }` — produced by the
 *   global error/not-found handlers (src/server/index.ts) and by handlers
 *   that fail a request directly, so validation errors, auth failures, 404s,
 *   and 500s all look the same to a client.
 * - Paginated: success plus a `pagination` block, driven by the shared
 *   `page`/`limit` query params. Every paginated route uses exactly these —
 *   don't add per-route `offset`/`pageSize` variants.
 */
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** A FastifyInstance whose route schemas are zod (what buildServer hands the route files). */
export type FastifyZodInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export const errorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string().describe('Stable machine-readable code, e.g. NOT_FOUND.'),
      message: z.string().describe('Human-readable description of the failure.'),
    }),
  })
  .describe('Uniform error envelope returned by every route for every failure status.');

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function errorBody(code: string, message: string): ErrorResponse {
  return { success: false, error: { code, message } };
}

export function successResponseSchema<T extends z.ZodType>(data: T) {
  return z.object({ success: z.literal(true), data });
}

/** Query params accepted by every paginated route: 1-based `page`, capped `limit`. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Items per page, max 100.'),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  totalItems: z.number().int(),
  totalPages: z.number().int(),
});

export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export function paginatedResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    success: z.literal(true),
    data: z.array(item),
    pagination: paginationMetaSchema,
  });
}

export function paginationMeta(query: PaginationQuery, totalItems: number): PaginationMeta {
  return {
    page: query.page,
    limit: query.limit,
    totalItems,
    totalPages: Math.ceil(totalItems / query.limit),
  };
}
