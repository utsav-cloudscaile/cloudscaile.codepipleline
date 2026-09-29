import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from './jwt.js';
import { decodeJwtPayload } from './jwt.js';

/**
 * Decorates `app` with `authenticate`, a preHandler that decode-only-parses the
 * gateway-forwarded JWT into `request.user`. Not signature verification — the
 * gateway in front of this service already did that (see CLAUDE.md, "Trigger
 * server"); this only recovers the caller identity for logging/audit. Apply it
 * as `onRequest`/`preHandler` on routes that require a caller identity —
 * `/open/*` routes (docs, openapi.json) skip it by convention.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // Same `{ success: false, error }` envelope as every other failure
      // (src/server/schemas/common.ts) — kept inline rather than imported so
      // auth doesn't depend on the server area.
      const unauthorized = {
        success: false as const,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      };
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        reply.code(401).send(unauthorized);
        return;
      }
      try {
        request.user = decodeJwtPayload(authHeader.slice('Bearer '.length));
      } catch {
        reply.code(401).send(unauthorized);
      }
    },
  );
}

/**
 * The caller identity every route and the persistence layer key on:
 * JWT `sub`, falling back to `email`, falling back to 'unknown' (a decoded
 * payload with neither claim). Centralized so /v1/trigger writes runs under
 * exactly the same userId the /v1/sessions read routes filter by.
 */
export function callerIdentity(user: JwtPayload | undefined): {
  userId: string;
  userEmail?: string;
} {
  return {
    userId: user?.sub ?? user?.email ?? 'unknown',
    ...(user?.email !== undefined && { userEmail: user.email }),
  };
}

export type { JwtPayload } from './jwt.js';
