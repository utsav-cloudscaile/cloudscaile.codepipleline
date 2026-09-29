/**
 * CRUD routes over per-repo standing instructions (src/db/repoInstructions.ts):
 *
 *   POST   /v1/repo-instructions        — create a named instruction block
 *   GET    /v1/repo-instructions        — list blocks, paginated, optionally
 *                                          narrowed via ?repoUrl=
 *   GET    /v1/repo-instructions/:id    — fetch one
 *   PATCH  /v1/repo-instructions/:id    — update name/content/enabled
 *   DELETE /v1/repo-instructions/:id    — delete one
 *
 * These aren't files committed to the target repo (cf. GitHub Copilot's
 * `.github/copilot-instructions.md`, Cursor's `.cursor/rules/*.mdc`) — they're
 * managed through this API so instructions can be configured for a repo
 * without needing write access to that repo's own tree. Enabled entries are
 * read by POST /v1/trigger (src/server/routes/v1/trigger.ts) and layered,
 * XML-tagged, into the stage's system prompt (see formatRepoInstructions,
 * src/pipeline/repoInstructions.ts).
 *
 * Associated with the repo only, not the caller: unlike routes/v1/sessions.ts,
 * there is no userId scoping here — every authenticated caller shares the
 * same instruction set for a given repo (src/db/repoInstructions.ts). Routes
 * still require auth (`app.authenticate`) per the service-wide convention
 * that every non-`/open/` route does; auth here just establishes "a valid
 * caller of this API", not "owner of this instruction block".
 */
import type { RepoInstructionQueries } from '@/db/index.js';
import {
  errorBody,
  errorResponseSchema,
  type FastifyZodInstance,
  paginatedResponseSchema,
  paginationMeta,
  successResponseSchema,
} from '../../schemas/common.js';
import {
  createRepoInstructionBodySchema,
  repoInstructionParamsSchema,
  repoInstructionQuerySchema,
  repoInstructionSchema,
  updateRepoInstructionBodySchema,
} from '../../schemas/repoInstructions.js';

export interface RepoInstructionRouteOptions {
  queries: RepoInstructionQueries;
}

function notFound(id: string) {
  return errorBody('NOT_FOUND', `No repo instruction "${id}"`);
}

export function registerRepoInstructionRoutes(
  app: FastifyZodInstance,
  options: RepoInstructionRouteOptions,
): void {
  app.post(
    '/repo-instructions',
    {
      schema: {
        description:
          'Creates a named instruction block for a repo. Enabled blocks are injected into the ' +
          'pipeline system prompt (XML-tagged) the next time that repo is triggered. Fails with ' +
          '409 CONFLICT if a block with the same name already exists for this repo — use PATCH ' +
          'to update it instead.',
        tags: ['repo-instructions'],
        body: createRepoInstructionBodySchema,
        response: {
          201: successResponseSchema(repoInstructionSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const created = await options.queries.create(request.body);
      return reply.code(201).send({ success: true as const, data: created });
    },
  );

  app.get(
    '/repo-instructions',
    {
      schema: {
        description:
          'Lists repo instruction blocks, most recently updated first. Narrow to one repo via ' +
          '?repoUrl=.',
        tags: ['repo-instructions'],
        querystring: repoInstructionQuerySchema,
        response: {
          200: paginatedResponseSchema(repoInstructionSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request) => {
      const { repoUrl, ...page } = request.query;
      const { items, total } = await options.queries.list(repoUrl, page);
      return {
        success: true as const,
        data: items,
        pagination: paginationMeta(page, total),
      };
    },
  );

  app.get(
    '/repo-instructions/:id',
    {
      schema: {
        description: 'Fetches one repo instruction block. 404 when it does not exist.',
        tags: ['repo-instructions'],
        params: repoInstructionParamsSchema,
        response: {
          200: successResponseSchema(repoInstructionSchema),
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const found = await options.queries.getById(request.params.id);
      if (found === null) {
        return reply.code(404).send(notFound(request.params.id));
      }
      return { success: true as const, data: found };
    },
  );

  app.patch(
    '/repo-instructions/:id',
    {
      schema: {
        description:
          'Updates name/content/enabled on one repo instruction block. 404 when it does not ' +
          'exist; 409 if the new name collides with another block on the same repo.',
        tags: ['repo-instructions'],
        params: repoInstructionParamsSchema,
        body: updateRepoInstructionBodySchema,
        response: {
          200: successResponseSchema(repoInstructionSchema),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const updated = await options.queries.update(request.params.id, request.body);
      if (updated === null) {
        return reply.code(404).send(notFound(request.params.id));
      }
      return { success: true as const, data: updated };
    },
  );

  app.delete(
    '/repo-instructions/:id',
    {
      schema: {
        description: 'Deletes one repo instruction block. 404 when it does not exist.',
        tags: ['repo-instructions'],
        params: repoInstructionParamsSchema,
        response: {
          200: successResponseSchema(repoInstructionParamsSchema),
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
      onRequest: app.authenticate,
    },
    async (request, reply) => {
      const deleted = await options.queries.remove(request.params.id);
      if (!deleted) {
        return reply.code(404).send(notFound(request.params.id));
      }
      return { success: true as const, data: { id: request.params.id } };
    },
  );
}
