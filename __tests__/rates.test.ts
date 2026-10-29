import { MIN_RATE_BASE, perSession, rateOf, subtitle } from '../client/src/lib/rates';

// Cifras reales de Careless x Mote & Livsstil, 26-27/10/2026.
const SESSIONS = 2145;
const IMPRESSIONS = 14637;
const CLICKS = 579;
const PURCHASES = 1;

describe('rateOf', () => {
  it('names the denominator, because the number alone is not a claim', () => {
    expect(rateOf(CLICKS, SESSIONS, 'sessions')).toBe('27.0% of sessions');
    expect(rateOf(CLICKS, IMPRESSIONS, 'impressions')).toBe('4.0% of impressions');
  });

  it('keeps a second decimal under 1%, where purchase conversion lives', () => {
    // Con un solo decimal esto sería "0.0% of sessions" habiendo una compra de verdad.
    expect(rateOf(PURCHASES, SESSIONS, 'sessions')).toBe('0.05% of sessions');
    expect(rateOf(11, 2145, 'sessions')).toBe('0.51% of sessions');
  });

  it('says nothing instead of dividing by nothing', () => {
    expect(rateOf(5, 0, 'sessions')).toBeUndefined();
    expect(rateOf(5, null, 'sessions')).toBeUndefined();
    expect(rateOf(0, SESSIONS, 'sessions')).toBeUndefined();
    expect(rateOf(undefined, SESSIONS, 'sessions')).toBeUndefined();
  });
});

describe('perSession', () => {
  it('counts impressions per reader rather than a share of them', () => {
    expect(perSession(IMPRESSIONS, SESSIONS)).toBe('6.8 per session');
  });

  it('says nothing without sessions', () => {
    expect(perSession(IMPRESSIONS, 0)).toBeUndefined();
  });
});

describe('subtitle', () => {
  it('drops the parts with no data behind them', () => {
    expect(subtitle('579 clicks', rateOf(CLICKS, SESSIONS, 'sessions'))).toBe('579 clicks · 27.0% of sessions');
    expect(subtitle(undefined, '+12% vs prev')).toBe('+12% vs prev');
    expect(subtitle(undefined, undefined)).toBeUndefined();
  });
});

describe('MIN_RATE_BASE', () => {
  it('leaves the two days of Careless below the bar, which is the point', () => {
    const checkouts = 6; // base del paso pago -> compra
    expect(checkouts).toBeLessThan(MIN_RATE_BASE);
    expect(CLICKS).toBeGreaterThanOrEqual(MIN_RATE_BASE);
  });
});
