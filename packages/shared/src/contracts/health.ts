import { z } from 'zod';

/**
 * One health shape for both services, so `/status` renders them with one
 * component and the E2E suite asserts on one parse.
 */

export const healthCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'fail']),
  latencyMs: z.number().int().nonnegative(),
  /** An error MESSAGE when it failed, never a stack: this body is public. */
  detail: z.string().nullable(),
});

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.enum(['api', 'sync']),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  checks: z.array(healthCheckSchema),
  /**
   * Sync only. This replica's own counts, deliberately not adapter-wide
   * numbers: asking the other replica for its totals would make the health
   * check depend on the thing it is trying to measure.
   */
  connections: z.number().int().nonnegative().optional(),
  documents: z.number().int().nonnegative().optional(),
});

export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type Health = z.infer<typeof healthSchema>;
