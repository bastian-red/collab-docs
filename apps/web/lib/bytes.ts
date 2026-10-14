/**
 * "42.1 KiB", for the metadata line and the version list.
 *
 * Binary units, because the number is a byte length of a Yjs state and the size
 * ceiling it is measured against (`DOCUMENT_MAX_BYTES`, 5 MiB) is binary too.
 * `toFixed` rather than `Intl.NumberFormat`: the output must be identical on the
 * server render and in the browser regardless of locale, or hydration warns, and
 * a locale's decimal comma here would be the only comma in a mono string.
 */
const UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(Math.round(value))} B` : `${value.toFixed(1)} ${UNITS[unit]!}`;
}
