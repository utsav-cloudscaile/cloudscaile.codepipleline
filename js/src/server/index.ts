/**
 * Fastify server composition root. The actual endpoints live in
 * `routes/v1/*` (one file per resource, registered under the `/v1` prefix)
 * and their zod contracts in `schemas/*` — this file only wires the shared
 * machinery every route relies on:
 *
 * - zod validation/serialization compilers (fastify-type-provider-zod)
 * - the uniform response envelope: global error + not-found handlers emit
 *   `{ success: false, error: { code, message } }` for every failure —
 *   validation 400s, auth 401s, unknown routes, and unhandled 500s — so
 *   handlers only ever produce envelope-shaped output
 *   (src/server/schemas/common.ts)
 * - Swagger UI + OpenAPI doc at /open/* (public by convention), generated
 *   from the same zod schemas that validate requests
 * - decode-only JWT auth (src/auth) — the gateway in front of this service
 *   verified the signature; every non-/open/ route applies
 *   `onRequest: app.authenticate`
 *
 * Routes are versioned under /v1 so a future breaking change ships as /v2
 * alongside, not as a silent contract change.
 */

import type { SwaggerTransformObject } from '@fastify/swagger';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerAuth } from '@/auth/index.js';
import type { AppConfig } from '@/config/index.js';
import {
  type RepoInstructionQueries,
  repoInstructionQueries,
  type SessionQueries,
  sessionQueries,
  type UsageQueries,
  usageQueries,
} from '@/db/index.js';
import type { PolicyConfig } from '@/guardrails/index.js';
import type { McpServerRegistry } from '@/mcp/index.js';
import { runPipeline } from '@/pipeline/index.js';
import { registerRepoInstructionRoutes } from './routes/v1/repo-instructions.js';
import { registerSessionRoutes } from './routes/v1/sessions.js';
import { registerTriggerRoute } from './routes/v1/trigger.js';
import { errorBody } from './schemas/common.js';

export const DOCS_ROUTE_PREFIX = '/open/docs';
export const OPENAPI_JSON_ROUTE = '/open/openapi.json';

export interface BuildServerOptions {
  config: AppConfig;
  mcpServers: McpServerRegistry;
  policy: PolicyConfig;
  /** Overridable in tests so a real Agent SDK/git call never happens. */
  runPipelineFn?: typeof runPipeline;
  /** Overridable in tests so the read routes never need a real MongoDB. */
  sessionQueries?: SessionQueries;
  /** Overridable in tests so the trigger route's usage-limit check never needs a real MongoDB. */
  usageQueries?: UsageQueries;
  /**
   * Overridable in tests so the /v1/repo-instructions CRUD routes — and the
   * trigger route's read of them — never need a real MongoDB.
   */
  repoInstructionQueries?: RepoInstructionQueries;
  /** Fastify's request logger. Defaults to on; tests pass `false` to keep output quiet. */
  logger?: boolean;
}

type OpenApiOperation = {
  security?: Array<Record<string, string[]>>;
  responses?: unknown;
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

/**
 * Marks every non-`/open/*` operation in the generated OpenAPI doc as requiring the
 * `Bearer` scheme, without hand-adding `security` to each route's schema — matches every
 * route automatically, including ones added later. Mirrors the equivalent pattern in the
 * patient-management-portal template's swagger plugin.
 */
const transformObject: SwaggerTransformObject = (documentObject) => {
  if (!('openapiObject' in documentObject)) {
    return documentObject.swaggerObject;
  }

  const doc = documentObject.openapiObject as unknown as OpenApiDocument;
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (path.startsWith('/open/')) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.responses) {
        continue;
      }
      operation.security = [...(operation.security ?? []), { Bearer: [] }];
    }
  }
  return documentObject.openapiObject;
};

/** Maps an HTTP status onto the stable `error.code` the envelope promises. */
function statusToCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED';
  }
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();
  const run = options.runPipelineFn ?? runPipeline;
  const queries = options.sessionQueries ?? sessionQueries;
  const usage = options.usageQueries ?? usageQueries;
  const repoInstructions = options.repoInstructionQueries ?? repoInstructionQueries;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Every failure — zod validation, thrown handler errors, plugin errors —
  // leaves the process as the same envelope. 5xx details stay in the logs,
  // not the response body.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(errorBody('VALIDATION_ERROR', error.message));
    }
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
    }
    // 503 is a deliberate, client-actionable signal (retry later) — its
    // message is safe to expose. Every other 5xx is an unexpected internal
    // failure whose details belong in the logs, not the response.
    const exposeMessage = statusCode < 500 || statusCode === 503;
    return reply
      .code(statusCode)
      .send(
        errorBody(
          statusToCode(statusCode),
          exposeMessage ? error.message : 'Internal server error',
        ),
      );
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`));
  });

  // Awaited, not fire-and-forget: @fastify/swagger captures route schemas
  // via an onRoute hook it wires up while its plugin body runs. Registering
  // a route before that hook exists (e.g. via an un-awaited
  // `void app.register(...)`) means it's silently missing from the
  // generated OpenAPI doc, even though the route itself still works.
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'code-pipeline trigger API',
        description:
          'Triggers pipeline runs (clone/pull a target repo, apply a prompt-driven change, ' +
          'commit, push) and reads back the persisted conversations. All routes are versioned ' +
          'under /v1; all JSON responses use the shared success/error envelope, and all ' +
          'paginated routes use the shared page/limit contract.',
        version: '0.0.1',
      },
      components: {
        securitySchemes: {
          Bearer: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'JWT forwarded by the API gateway. The gateway verifies the signature; this ' +
              'service only decodes the payload to know the caller.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject,
  });
  await app.register(fastifySwaggerUi, { routePrefix: DOCS_ROUTE_PREFIX });

  app.get(OPENAPI_JSON_ROUTE, async () => app.swagger());

  // Decode-only JWT auth (src/auth) — the gateway in front of this service already
  // verified the signature. Applied per-route in routes/v1/*, not globally, so /open/*
  // stays public.
  await registerAuth(app);

  // All API routes live under the /v1 prefix, one file per resource.
  await app.register(
    async (v1) => {
      const typed = v1.withTypeProvider<ZodTypeProvider>();
      registerTriggerRoute(typed, {
        config: options.config,
        mcpServers: options.mcpServers,
        policy: options.policy,
        run,
        usage,
        repoInstructions,
      });
      registerSessionRoutes(typed, { queries });
      registerRepoInstructionRoutes(typed, { queries: repoInstructions });
    },
    { prefix: '/v1' },
  );

  return app;
}
