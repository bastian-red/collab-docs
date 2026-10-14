/**
 * The sync server's configuration, read once at boot and validated here.
 *
 * Every value is read from `process.env` in this file and nowhere else, so
 * `scripts/env-contract.mjs` finds every name in one place and a reader can see
 * the whole surface without grepping. Turbo runs in strict env mode: a name not
 * declared in `turbo.json` never reaches this process, and the failure is a
 * missing value rather than an error, which is why every read below is checked.
 */

export interface SyncConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly authSecret: string;
  readonly appVersion: string;
  readonly compaction: { readonly afterUpdates: number; readonly afterSeconds: number };
  readonly versions: { readonly intervalSeconds: number; readonly maxPerDocument: number };
  readonly storeDebounceMs: number;
  readonly storeMaxDebounceMs: number;
  readonly maxPayloadBytes: number;
  readonly messageRateLimit: number;
  readonly documentMaxBytes: number;
  readonly awarenessTimeoutMs: number;
}

class ConfigError extends Error {}

/**
 * Every helper takes the NAME and the RAW VALUE, rather than reading
 * `process.env[name]` itself.
 *
 * That looks redundant and is not. `scripts/env-contract.mjs` finds the names a
 * process reads by scanning for `process.env.NAME`, and a helper that indexes
 * `process.env` with a variable is invisible to it -- so every name in this file
 * would be reported as "documented but read by nothing", and the fix would be to
 * weaken the gate. Writing the access at the call site keeps the contract
 * checkable and makes the whole surface greppable: `grep -rn process.env.REDIS_URL`
 * finds the one line that reads it.
 */
function required(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      `${name} is not set. It must be present in .env AND declared in turbo.json's ` +
        'globalPassThroughEnv; turbo strips undeclared names silently.',
    );
  }
  return raw;
}

function optional(raw: string | undefined, fallback: string): string {
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function integer(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

/**
 * `PORT` beats `SYNC_PORT`.
 *
 * That precedence is the entire reason a second replica exists without a second
 * Dockerfile: `infra/docker-compose.yml` runs the same image twice and gives the
 * second one `PORT=4101`. Reversing it would make the override in the compose
 * file silently do nothing, and the integration lane's cross-replica test would
 * "pass" with both clients on one process -- the exact failure it exists to
 * catch. See docs/SPECS.md sections 2.1 and 7.1.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim() || env.SYNC_PORT?.trim();
  if (raw === undefined || raw === '') {
    throw new ConfigError('Neither PORT nor SYNC_PORT is set.');
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigError(`PORT/SYNC_PORT must be a TCP port, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

export function loadConfig(): SyncConfig {
  const config: SyncConfig = {
    port: resolvePort(),
    databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
    redisUrl: required('REDIS_URL', process.env.REDIS_URL),
    // Required, not defaulted. A sync server that boots with a generated secret
    // accepts no token the API ever minted, so every handshake fails and the
    // symptom is "collaboration is broken", not "a variable is missing".
    authSecret: required('AUTH_SECRET', process.env.AUTH_SECRET),
    appVersion: optional(process.env.APP_VERSION, '0.0.0-dev'),
    compaction: {
      afterUpdates: integer('COMPACT_AFTER_UPDATES', process.env.COMPACT_AFTER_UPDATES, 200),
      afterSeconds: integer('COMPACT_AFTER_SECONDS', process.env.COMPACT_AFTER_SECONDS, 120),
    },
    versions: {
      intervalSeconds: integer(
        'VERSION_INTERVAL_SECONDS',
        process.env.VERSION_INTERVAL_SECONDS,
        300,
      ),
      maxPerDocument: integer('VERSION_MAX_PER_DOCUMENT', process.env.VERSION_MAX_PER_DOCUMENT, 50),
    },
    storeDebounceMs: integer('STORE_DEBOUNCE_MS', process.env.STORE_DEBOUNCE_MS, 2000),
    storeMaxDebounceMs: integer('STORE_MAX_DEBOUNCE_MS', process.env.STORE_MAX_DEBOUNCE_MS, 10_000),
    maxPayloadBytes: integer(
      'SYNC_MAX_PAYLOAD_BYTES',
      process.env.SYNC_MAX_PAYLOAD_BYTES,
      1_048_576,
    ),
    messageRateLimit: integer('SYNC_MESSAGE_RATE_LIMIT', process.env.SYNC_MESSAGE_RATE_LIMIT, 1200),
    documentMaxBytes: integer('DOCUMENT_MAX_BYTES', process.env.DOCUMENT_MAX_BYTES, 5_242_880),
    awarenessTimeoutMs: integer('AWARENESS_TIMEOUT_MS', process.env.AWARENESS_TIMEOUT_MS, 30_000),
  };

  assertCoherent(config);
  return config;
}

/**
 * Relationships between values, checked at boot rather than discovered at 3am.
 *
 * Each of these is a configuration that starts cleanly and behaves wrongly, which
 * is the worst kind: nothing in the logs says the numbers disagree.
 */
export function assertCoherent(config: SyncConfig): void {
  if (config.storeMaxDebounceMs < config.storeDebounceMs) {
    throw new ConfigError(
      `STORE_MAX_DEBOUNCE_MS (${config.storeMaxDebounceMs}) is below STORE_DEBOUNCE_MS ` +
        `(${config.storeDebounceMs}). The maximum is a ceiling on the debounce, so a lower value ` +
        'means continuous typing defers the checkpoint forever.',
    );
  }
  if (config.maxPayloadBytes >= config.documentMaxBytes) {
    throw new ConfigError(
      `SYNC_MAX_PAYLOAD_BYTES (${config.maxPayloadBytes}) is not below DOCUMENT_MAX_BYTES ` +
        `(${config.documentMaxBytes}). A single frame that may exceed the whole document's ` +
        'ceiling makes the ceiling unreachable: the frame is refused first, always.',
    );
  }
}

export { ConfigError };
