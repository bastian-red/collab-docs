/**
 * Auth.js's HTTP surface, re-exported rather than reimplemented.
 *
 * `/api/auth/csrf`, `/api/auth/callback/credentials` and `/api/auth/session` are
 * a stable interface, and `scripts/dev-smoke.sh` signs in through exactly those
 * three the way a browser does.
 */
import { handlers } from '../../../../auth';

export const { GET, POST } = handlers;
