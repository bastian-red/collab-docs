import { healthSchema, type Health } from '@docs/shared';

import { probeHealth, type Probe } from '../../lib/api';
import { apiBaseUrl, appVersion, syncBaseUrl, syncBaseUrl2 } from '../../lib/config';

export const metadata = { title: 'Service status' };
// Read on every request: a cached status page reports the health of a moment
// that has passed, which is worse than none.
export const dynamic = 'force-dynamic';

interface Card {
  readonly name: string;
  readonly probe: Probe;
  readonly health: Health | null;
}

/**
 * Both services' `/health`, rendered (docs/DESIGN.md 3.5, docs/SPECS.md 10).
 *
 * The page renders a failure rather than failing with one: a status page that 500s
 * because a dependency is down cannot report that the dependency is down. An
 * unreachable probe shows its error class (ECONNREFUSED, TimeoutError), never the
 * message, which would print internal hosts on a public page.
 *
 * `sync-2` appears only when `SYNC_BASE_URL_2` is set. One replica green and the
 * other red is this product's worst failure, so when a second exists it is probed.
 */
export default async function StatusPage() {
  const targets: Array<[string, string]> = [
    ['api', apiBaseUrl],
    ['sync', syncBaseUrl],
    ...(syncBaseUrl2 === undefined ? [] : ([['sync-2', syncBaseUrl2]] as Array<[string, string]>)),
  ];
  const cards: Card[] = await Promise.all(
    targets.map(async ([name, url]) => {
      const probe = await probeHealth(url);
      const parsed = healthSchema.safeParse(probe.body);
      return { name, probe, health: parsed.success ? parsed.data : null };
    }),
  );
  const healthy = cards.every((card) => card.health?.status === 'ok');

  return (
    <main id="main" className="status-page">
      <header className="status-head">
        <p className="brand">collab-docs</p>
        <h1 className="status-title">Service status</h1>
        <p className="status-overall" data-state={healthy ? 'ok' : 'fail'}>
          <span aria-hidden="true">{healthy ? '● ' : '▲ '}</span>
          {healthy ? 'All services operational' : 'Something is degraded'}
        </p>
        <p className="muted">
          Web <span className="mono">{appVersion}</span>. Checked{' '}
          <time dateTime={new Date().toISOString()}>just now</time>.
        </p>
      </header>
      <div className="status-grid">
        {cards.map((card) => (
          <StatusCard key={card.name} card={card} />
        ))}
      </div>
    </main>
  );
}

function StatusCard({ card }: { readonly card: Card }) {
  const { health, probe } = card;
  const state = health === null ? 'unreachable' : health.status === 'ok' ? 'ok' : 'degraded';
  const label = state === 'ok' ? 'Operational' : state === 'degraded' ? 'Degraded' : 'Unreachable';
  const glyph = state === 'ok' ? '●' : '▲';

  return (
    <section className="status-card" aria-labelledby={`status-${card.name}`} data-state={state}>
      <h2 id={`status-${card.name}`} className="status-card-title">
        {card.name}
      </h2>
      <p className="status-state">
        <span aria-hidden="true">{glyph} </span>
        {label}
        {state === 'unreachable' ? (
          <span className="mono status-error">
            {' '}
            {probe.error ?? `HTTP ${String(probe.status)}`}
          </span>
        ) : null}
      </p>
      {health === null ? null : (
        <>
          <dl className="status-facts">
            <dt>Version</dt>
            <dd className="mono">{health.version}</dd>
            <dt>Uptime</dt>
            <dd className="mono">{health.uptimeSeconds}s</dd>
            {health.connections === undefined ? null : (
              <>
                <dt>Connections</dt>
                <dd className="mono">{health.connections}</dd>
              </>
            )}
            {health.documents === undefined ? null : (
              <>
                <dt>Open documents</dt>
                <dd className="mono">{health.documents}</dd>
              </>
            )}
          </dl>
          <table className="status-checks">
            <caption className="sr-only">Dependency checks for {card.name}</caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Result</th>
                <th scope="col">Latency</th>
              </tr>
            </thead>
            <tbody>
              {health.checks.map((check) => (
                <tr key={check.name} data-state={check.status}>
                  <th scope="row">{check.name}</th>
                  <td>
                    <span aria-hidden="true">{check.status === 'ok' ? '● ' : '▲ '}</span>
                    {check.status === 'ok' ? 'OK' : 'Failing'}
                  </td>
                  <td className="mono">{check.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
