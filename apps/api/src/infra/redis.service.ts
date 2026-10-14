/**
 * The API's Redis connection.
 *
 * One purpose only: it backs the throttler's storage. This process publishes
 * nothing and subscribes to nothing -- the document relay between sync replicas
 * is `@hocuspocus/extension-redis`'s business and happens in another process
 * entirely -- so one connection is enough and it never enters subscriber mode.
 *
 * The throttler's storage is Redis rather than the default in-memory one because
 * a limit that resets when a process restarts, and that counts separately on each
 * replica, is not a limit.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = new Redis(config.redisUrl, {
      // Fail rather than queue. The default buffers commands issued before the
      // connection is up and replays them later, which would let `/health` pass
      // against a Redis that is not there.
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    // Attached in the constructor, before anything can connect. ioredis emits
    // `error` on a blip, and an EventEmitter with no `error` listener throws --
    // in Node an uncaught exception that takes the whole API down because Redis
    // hiccuped for 200ms.
    this.client.on('error', (error) => {
      console.error('[api] redis error', error);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    // `quit`, not `disconnect`: it waits for in-flight replies rather than
    // cutting the socket under one.
    await this.client.quit();
  }
}
