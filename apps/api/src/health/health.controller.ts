/**
 * `GET /health`.
 *
 * Two checks, each a real operation rather than a handle:
 *
 * - **Postgres** runs `SELECT 1`. A pool that believes it is connected to a
 *   server which closed the socket answers a liveness check perfectly and fails
 *   on the next query.
 * - **Redis** sends `PING`. It is not decorative here: the throttler's storage is
 *   Redis, and with `enableOfflineQueue: false` a dead Redis is a dead rate
 *   limiter rather than a slow one.
 *
 * There is deliberately no pub/sub round trip. That check belongs to `apps/sync`,
 * whose replicas relay document updates to each other over Redis and for whom a
 * silently dead subscriber is invisible from every other angle (docs/SPECS.md
 * 10). This process publishes nothing, so a round trip here would test a code
 * path the API does not have.
 *
 * 503 when any check fails, and the failing check is named in the body. Both
 * halves matter: `scripts/dev-smoke.sh` reads the body, because a 503 naming the
 * dead dependency is far more useful than a bare code, and
 * `infra/Dockerfile.api`'s HEALTHCHECK reads the status code, because a container
 * runtime cannot parse JSON.
 *
 * `@Public()`, because a probe that needs a credential is a probe a container
 * runtime cannot run. It reports dependency status and no data.
 */
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Health, HealthCheck } from '@docs/shared';
import type { Response } from 'express';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { Public } from '../common/session.guard';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * `@SkipThrottle()`, and this is the one route that gets it.
   *
   * A container healthcheck probes on a fixed interval from a fixed address. Left
   * under the global budget it would eventually spend it and start receiving 429s
   * -- at which point the runtime restarts a perfectly healthy process, and the
   * restart looks like the dependency failing.
   */
  @Public()
  @SkipThrottle()
  @Get()
  async health(@Res() response: Response): Promise<void> {
    const checks = await Promise.all([
      timed('postgres', async () => {
        await this.prisma.client.$queryRaw`SELECT 1`;
      }),
      timed('redis', async () => {
        await this.redis.client.ping();
      }),
    ]);

    const body: Health = {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      service: 'api',
      version: this.config.appVersion,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };

    response
      .status(body.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }
}

async function timed(name: string, run: () => Promise<void>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await run();
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - started,
      // The message, not the stack. This body is read by whoever is running
      // dev-smoke and by the /status page, and a stack is neither.
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
