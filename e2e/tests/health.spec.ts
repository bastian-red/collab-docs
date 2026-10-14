import { healthSchema } from '@docs/shared';

import { expect, test } from '../fixtures';

const API = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SYNC = process.env.SYNC_BASE_URL ?? 'http://localhost:4100';

test.describe('health', () => {
  test('both services answer /health with a body that parses and checks its dependencies', async ({
    request,
  }) => {
    for (const [base, service, checks] of [
      [API, 'api', ['postgres', 'redis']],
      [SYNC, 'sync', ['postgres', 'redis', 'redis-pubsub']],
    ] as const) {
      const response = await request.get(`${base}/health`);
      expect(response.status(), service).toBe(200);
      // Parsed with the shared contract, not grepped: a 200 with the wrong body is
      // a broken health check.
      const body = healthSchema.parse(await response.json());
      expect(body.service).toBe(service);
      expect(body.status).toBe('ok');
      expect(body.checks.map((check) => check.name).sort()).toEqual([...checks].sort());
      expect(body.checks.every((check) => check.status === 'ok')).toBe(true);
    }
  });

  test('/status renders both services from their real health, without signing in', async ({
    page,
  }) => {
    await page.goto('/status');
    await expect(page.getByRole('heading', { level: 1, name: 'Service status' })).toBeVisible();
    await expect(page.getByText('All services operational')).toBeVisible();
    for (const name of ['api', 'sync']) {
      const card = page.getByRole('region', { name });
      await expect(card.locator('.status-state')).toHaveText(/Operational/u);
    }
    await expect(page.getByRole('rowheader', { name: 'redis-pubsub' })).toBeVisible();
  });
});
