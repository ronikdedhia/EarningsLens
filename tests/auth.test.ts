import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { routeAccess, bearerToken, requireAuth } from '../src/backend/middleware/auth';
import { qstashVerify } from '../src/backend/middleware/qstash';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

// Next's type definitions mark NODE_ENV read-only.
function setNodeEnv(value: string) {
  (process.env as Record<string, string>).NODE_ENV = value;
}

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown, locals: {} as Record<string, unknown> };
  return Object.assign(res, {
    status(code: number) { res.statusCode = code; return this; },
    json(body: unknown) { res.body = body; return this; },
  }) as unknown as Response & { statusCode: number; body: unknown };
}

function run(mw: (req: Request, res: Response, next: () => void) => unknown, req: Partial<Request>) {
  const res = mockRes();
  let nextCalled = false;
  const done = Promise.resolve(mw(req as Request, res, () => { nextCalled = true; }));
  return done.then(() => ({ res, nextCalled }));
}

test('routeAccess: public reads, QStash schedules, everything else needs a user', () => {
  assert.equal(routeAccess('GET', '/companies'), 'public');
  assert.equal(routeAccess('GET', '/companies/'), 'public');
  assert.equal(routeAccess('GET', '/insights/WOCKPHARMA'), 'public');
  assert.equal(routeAccess('GET', '/sentiment'), 'public');

  assert.equal(routeAccess('POST', '/ingest/worker'), 'qstash');
  assert.equal(routeAccess('POST', '/daily-filings/run'), 'qstash');
  assert.equal(routeAccess('POST', '/companies/refresh-all'), 'qstash');
  assert.equal(routeAccess('POST', '/keepalive/ping'), 'qstash');

  // LLM, ingestion and write routes
  assert.equal(routeAccess('POST', '/ingest'), 'user');
  assert.equal(routeAccess('POST', '/query'), 'user');
  assert.equal(routeAccess('POST', '/insights/generate/WOCKPHARMA'), 'user');
  assert.equal(routeAccess('POST', '/companies/add-and-discover'), 'user');
  assert.equal(routeAccess('GET', '/diff'), 'user');
  assert.equal(routeAccess('GET', '/sector'), 'user');
  assert.equal(routeAccess('POST', '/keepalive/test-telegram'), 'user');
  // a GET on a QStash path is not a QStash call
  assert.equal(routeAccess('GET', '/ingest/worker'), 'user');
});

test('bearerToken parses the Authorization header', () => {
  assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(bearerToken('bearer  xyz '), 'xyz');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

test('requireAuth fails closed in production without CLERK_SECRET_KEY', async () => {
  setNodeEnv('production');
  delete process.env.CLERK_SECRET_KEY;
  const { res, nextCalled } = await run(requireAuth, { method: 'POST', path: '/ingest', headers: {} });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});

test('requireAuth allows everything in development without CLERK_SECRET_KEY', async () => {
  setNodeEnv('development');
  delete process.env.CLERK_SECRET_KEY;
  const { nextCalled } = await run(requireAuth, { method: 'POST', path: '/ingest', headers: {} });
  assert.equal(nextCalled, true);
});

test('requireAuth returns 401 without a token, and lets public routes through', async () => {
  setNodeEnv('production');
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy';

  const denied = await run(requireAuth, { method: 'POST', path: '/query', headers: {} });
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.statusCode, 401);

  const open = await run(requireAuth, { method: 'GET', path: '/companies', headers: {} });
  assert.equal(open.nextCalled, true);
});

test('requireAuth rejects a malformed token', async () => {
  setNodeEnv('production');
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy';
  const { res, nextCalled } = await run(requireAuth, {
    method: 'POST', path: '/query', headers: { authorization: 'Bearer not-a-jwt' },
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('qstashVerify fails closed in production without signing keys', async () => {
  setNodeEnv('production');
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  const { res, nextCalled } = await run(qstashVerify, { method: 'POST', path: '/worker', headers: {}, ip: '127.0.0.1' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('qstashVerify no longer trusts localhost and needs a signature', async () => {
  setNodeEnv('production');
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'k1';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'k2';
  const { res, nextCalled } = await run(qstashVerify, { method: 'POST', path: '/worker', headers: {}, ip: '127.0.0.1' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('qstashVerify allows local development without keys', async () => {
  setNodeEnv('development');
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  const { nextCalled } = await run(qstashVerify, { method: 'POST', path: '/worker', headers: {} });
  assert.equal(nextCalled, true);
});
