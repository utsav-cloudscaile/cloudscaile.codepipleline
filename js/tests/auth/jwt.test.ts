import { describe, expect, it } from 'vitest';
import { decodeJwtPayload } from '@/auth/jwt.js';

function makeJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('decodeJwtPayload', () => {
  it('decodes the payload segment without checking the signature', () => {
    const token = makeJwt({ sub: 'user-1', email: 'user@example.com' });
    expect(decodeJwtPayload(token)).toEqual({ sub: 'user-1', email: 'user@example.com' });
  });

  it('accepts a garbage signature segment — verification is the gateway’s job, not this service’s', () => {
    const token = makeJwt({ sub: 'user-1' });
    const [headerSeg, payloadSeg] = token.split('.');
    const tampered = `${headerSeg}.${payloadSeg}.not-a-real-signature`;
    expect(decodeJwtPayload(tampered)).toEqual({ sub: 'user-1' });
  });

  it('throws when the token does not have three dot-separated parts', () => {
    expect(() => decodeJwtPayload('only.two')).toThrow('Malformed JWT');
  });

  it('throws when the payload segment is not valid base64url JSON', () => {
    expect(() => decodeJwtPayload('header.not-json.signature')).toThrow();
  });

  it('throws when the decoded payload is not an object', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify('just a string')).toString('base64url');
    expect(() => decodeJwtPayload(`${header}.${body}.sig`)).toThrow('not an object');
  });
});
