/**
 * The three things every feature module needs: the config, Postgres, Redis.
 *
 * `@Global()`, which this codebase otherwise avoids. The justification is narrow
 * and worth stating: these are process-level singletons with a lifecycle, and the
 * alternative is importing this module into all six feature modules, where a
 * forgotten import is a runtime injection error rather than a compile error. A
 * global module for connections is a different thing from a global module for
 * business logic, and nothing with business logic goes in here.
 */
import { Global, Module } from '@nestjs/common';

import { API_CONFIG, loadConfig, type ApiConfig } from '../config/config';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      // Parsed once here. `main.ts` calls `loadConfig()` too, before the
      // application exists, so a bad environment fails with a plain sentence
      // rather than a Nest bootstrap stack; both calls are pure and agree.
      useFactory: (): ApiConfig => loadConfig(),
    },
    PrismaService,
    RedisService,
  ],
  exports: [API_CONFIG, PrismaService, RedisService],
})
export class InfraModule {}
