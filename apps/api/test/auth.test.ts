/**
 * The guard, and the two routes that get past it.
 *
 * The first three tests are about the property that makes the rest of this API
 * safe: **the guard is registered globally, so a route is authenticated unless
 * somebody wrote `@Public()` on it.** A guard applied per controller fails
 * silently in the direction that matters -- a forgotten decorator is an open
 * endpoint and nothing about the code looks wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IRIS, boot, call, loadSeedUsers, uniqueTitle, type Harness } from './support.js';

let harness: Harness;
const createdEmails: string[] = [];

beforeAll(async () => {
  harness = await boot();
  await loadSeedUsers(harness.db);
});

afterAll(async () => {
  if (createdEmails.length > 0) {
    await harness.db.user.deleteMany({ where: { email: { in: createdEmails } } });
  }
  await harness.close();
});

describe('the global session guard', () => {
  it.each([
    ['GET', '/documents'],
    ['GET', '/folders'],
    ['POST', '/documents'],
    ['GET', '/documents/cnosuchdocument0000000000'],
    ['GET', '/documents/cnosuchdocument0000000000/versions'],
    ['GET', '/documents/cnosuchdocument0000000000/members'],
    ['GET', '/documents/cnosuchdocument0000000000/links'],
    ['GET', '/share/abcdefghijklmnopqrstuvwx'],
  ])('refuses %s %s with no token', async (method, path) => {
    const reply = await call(harness, method, path, { user: null });
    expect(reply.status).toBe(401);
    // Every error body carries a `code`, including the ones Nest raises itself.
    // Without that a client would have to match on prose, and the first time
    // somebody improves the wording it breaks.
    expect(reply.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token signed with another secret, without saying which half was wrong', async () => {
    const wrongSecret = await call(harness, 'GET', '/documents', {
      user: IRIS,
      secret: 'a-completely-different-secret-value',
    });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'That token was not accepted.',
    });
  });

  it('admits a token this secret minted', async () => {
    const reply = await call(harness, 'GET', '/documents', { user: IRIS });
    expect(reply.status).toBe(200);
  });

  it('leaves /health public, because a container runtime cannot present a token', async () => {
    const reply = await call<{ status: string; service: string; checks: Array<{ name: string }> }>(
      harness,
      'GET',
      '/health',
      { user: null },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.service).toBe('api');
    expect(reply.body.status).toBe('ok');
    // Asserted on content, not on the status code: a broken app answers 200 with
    // a body that says nothing. These are the two dependencies that must have
    // been really asked.
    expect(reply.body.checks.map((check) => check.name).sort()).toEqual(['postgres', 'redis']);
  });
});

describe('sign up and sign in', () => {
  it('creates an account and signs into it', async () => {
    const email = `${uniqueTitle('probe').replace(/[^a-z0-9]/gu, '')}@collab.test`;
    createdEmails.push(email);

    const created = await call<{ id: string; email: string; name: string }>(
      harness,
      'POST',
      '/auth/sign-up',
      { user: null, body: { email, name: 'A Probe', password: 'a-long-enough-password' } },
    );
    expect(created.status).toBe(201);
    expect(created.body.email).toBe(email);

    const signedIn = await call<{ id: string }>(harness, 'POST', '/auth/sign-in', {
      user: null,
      body: { email, password: 'a-long-enough-password' },
    });
    // 200, not 201: signing in creates nothing. The session is the web app's and
    // lives in a cookie this process never sees.
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.id).toBe(created.body.id);
  });

  it('refuses a second account on one address, by constraint name', async () => {
    const reply = await call(harness, 'POST', '/auth/sign-up', {
      user: null,
      body: { email: IRIS.email, name: 'Not Iris', password: 'a-long-enough-password' },
    });
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'CONFLICT' });
  });

  /**
   * The sign-in form must not be a list of who has an account here. A wrong
   * password and an unknown address get the same status and the same sentence.
   */
  it('answers a wrong password exactly as it answers an unknown address', async () => {
    const wrongPassword = await call(harness, 'POST', '/auth/sign-in', {
      user: null,
      body: { email: IRIS.email, password: 'not-the-right-password' },
    });
    const unknownAddress = await call(harness, 'POST', '/auth/sign-in', {
      user: null,
      body: { email: 'nobody-at-all@collab.test', password: 'not-the-right-password' },
    });

    expect(wrongPassword.status).toBe(400);
    expect(unknownAddress.status).toBe(400);
    expect(wrongPassword.body).toEqual(unknownAddress.body);
  });

  /**
   * Zod quotes the offending input back for a length rule, and here that input
   * is somebody's password. The response is a fixed sentence plus the field
   * NAMES.
   */
  it('never puts a rejected password in the response', async () => {
    const password = 'short';
    const reply = await call(harness, 'POST', '/auth/sign-up', {
      user: null,
      body: { email: 'someone@collab.test', name: 'Someone', password },
    });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).not.toContain(password);
    expect(reply.body).toEqual({
      code: 'INVALID',
      message: 'That request was not in a shape this server accepts.',
      fields: ['password'],
    });
  });
});
