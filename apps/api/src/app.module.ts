/**
 * The application graph.
 *
 * Two global bindings, both arranged so the unsafe direction is the one that
 * needs a decision:
 *
 * - **`SessionGuard` is global.** A route added next year is authenticated unless
 *   somebody writes `@Public()` on it. The opposite arrangement -- a guard
 *   applied per controller -- fails silently in the direction that matters,
 *   because a forgotten decorator is an open endpoint and nothing about the code
 *   looks wrong.
 * - **`ThrottlerGuard` is global**, so the general budget applies everywhere and
 *   `@Throttle({ auth: {} })` NARROWS it on the two auth routes rather than
 *   widening it. `/health` is the single `@SkipThrottle()`.
 *
 * Guard order is the registration order, and it is deliberate: the throttler runs
 * first, so a flood of unauthenticated requests is refused before any of them
 * costs an HMAC verification.
 *
 * The throttler's storage is Redis rather than the default in-memory one, because
 * a limit that resets when a process restarts, and that counts separately on each
 * replica, is not a limit.
 */
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { API_CONFIG, type ApiConfig } from './config/config';
import { AccessService } from './access/access.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { FoldersController } from './folders/folders.controller';
import { FoldersService } from './folders/folders.service';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { RedisService } from './infra/redis.service';
import { SessionGuard } from './common/session.guard';
import { ShareController, ShareLinksController } from './share-links/share-links.controller';
import { ShareLinksService } from './share-links/share-links.service';
import { VersionsController } from './versions/versions.controller';
import { VersionsService } from './versions/versions.service';

@Module({
  imports: [
    InfraModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: [
          // The general budget, per client address, per minute.
          { name: 'default', ttl: 60_000, limit: config.rateLimitGlobal },
          // Auth is the credential-stuffing surface, so its budget is an order of
          // magnitude below the general one. Named, so `@Throttle({ auth: {} })`
          // on sign-up and sign-in selects it. `assertConsistent` refuses to boot
          // if the two numbers are the wrong way round.
          { name: 'auth', ttl: 60_000, limit: config.rateLimitAuth },
        ],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  controllers: [
    AuthController,
    DocumentsController,
    FoldersController,
    MembersController,
    ShareLinksController,
    ShareController,
    VersionsController,
    HealthController,
  ],
  providers: [
    AccessService,
    AuthService,
    DocumentsService,
    FoldersService,
    MembersService,
    ShareLinksService,
    VersionsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
