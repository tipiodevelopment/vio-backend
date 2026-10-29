import { MIN_RATE_BASE, formatPct } from '@/lib/rates';

/**
 * A rate as the headline number, for reading at a glance.
 *
 * The denominator is always on screen. A percentage whose base you cannot see is not a
 * fact, and these bases are often small: a campaign's first days run on a handful of
 * checkouts, where "17%" is one sale out of six. Below MIN_RATE_BASE the number is
 * dimmed, so the eye skips it instead of trusting it.
 */
export function RateCard({ label, value, base, of, testId }: {
  label: string;
  value: number | null | undefined;
  base: number | null | undefined;
  of: string;
  testId: string;
}) {
  const n = Number(value ?? 0);
  const b = Number(base ?? 0);
  const thin = b > 0 && b < MIN_RATE_BASE;

  return (
    <div className="bg-white dark:bg-[#141824] border border-gray-200 dark:border-white/10 rounded-lg p-5" data-testid={testId}>
      <span className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">{label}</span>
      <div
        className={`text-2xl font-bold mt-3 ${thin ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-white'}`}
        title={thin ? `Only ${b.toLocaleString()} ${of} behind this — too few to read as a rate` : undefined}
      >
        {b > 0 ? formatPct((n / b) * 100) : '--'}
      </div>
      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
        {b > 0 ? `${n.toLocaleString()} / ${b.toLocaleString()} ${of}` : `no ${of} yet`}
      </div>
    </div>
  );
}
