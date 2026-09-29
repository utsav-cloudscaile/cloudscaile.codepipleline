/**
 * The trigger server sits behind an API gateway that terminates and verifies
 * the caller's JWT before forwarding the request here — see CLAUDE.md
 * ("Trigger server"). This module never checks a signature; it only decodes
 * the payload the gateway already validated, so the pipeline can know who
 * asked for a run (for logging/audit) without re-implementing verification
 * the gateway has already done.
 */
export interface JwtPayload {
  sub?: string;
  email?: string;
  [key: string]: unknown;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    user?: JwtPayload;
  }
}

/** Decodes (without verifying) the payload segment of a JWT. Throws on anything malformed. */
export function decodeJwtPayload(token: string): JwtPayload {
  const [, payloadSegment, signature] = token.split('.');
  if (!payloadSegment || signature === undefined) {
    throw new Error('Malformed JWT: expected 3 dot-separated parts');
  }
  const decoded = Buffer.from(payloadSegment, 'base64url').toString('utf-8');
  const parsed: unknown = JSON.parse(decoded);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Malformed JWT: payload is not an object');
  }
  return parsed as JwtPayload;
}
