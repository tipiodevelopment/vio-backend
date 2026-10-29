/**
 * Rates for the analytics tiles.
 *
 * An absolute number says how much happened; a rate says whether it is going well. The
 * denominator is the whole point, so every helper here names it in the string it returns:
 * "4.0% of sessions" is a different claim from "4.0% of impressions", and the two get
 * compared by eye the moment they sit in the same card.
 */

/**
 * Below this many events in the base, a rate is noise dressed as a fact. Callers show
 * those dimmed and next to the raw fraction, so nobody reads 1 of 6 as "17%".
 */
export const MIN_RATE_BASE = 30;

/** A share of its base, e.g. "4.0% of sessions". Undefined when there is nothing to divide by. */
export function rateOf(value: number | null | undefined, base: number | null | undefined, unit: string): string | undefined {
  if (!base || !value) return undefined;
  return `${formatPct((value / base) * 100)} of ${unit}`;
}

/**
 * A percentage with the precision its size deserves. Shares under 1% get a second
 * decimal: purchase conversion lives there (0.5% is an ordinary fashion store), and
 * one decimal would round a real number of sales down to "0.0%".
 */
export function formatPct(pct: number): string {
  return `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
}

/** Impressions read better as a count per session than as a share: one reader sees several. */
export function perSession(value: number | null | undefined, sessions: number | null | undefined): string | undefined {
  if (!sessions || !value) return undefined;
  return `${(value / sessions).toFixed(1)} per session`;
}

/** Joins subtitle parts, dropping the ones with no data behind them. */
export function subtitle(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter(Boolean);
  return kept.length ? kept.join(' · ') : undefined;
}
