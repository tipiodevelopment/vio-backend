/**
 * What kind of Commerce account is calling (2026-09-16).
 *
 * Commerce is the only place that creates accounts; Vio provisions its own
 * user on the first Firebase-bearer call from what Commerce says the account
 * is:
 *
 *   seller            (signed up for Channel/broadcast) → Vio `admin`: owns its surfaces
 *   business|supplier (owns the products)               → Vio `sponsor` + its sponsor row
 *   both, or neither  → not provisioned (403)
 *
 * Two sources, cheapest first:
 *   1. The ID token's custom claims, set at signup by vio-users-microservice
 *      (`business`, `channel`, `brand_name`). The `channel` flag exists ONLY
 *      as a claim (no DB column); every Channel signup sends it since
 *      2026-08-19, so it is the one and only seller signal.
 *   2. Commerce itself, with the same token, when COMMERCE_API_URL is set:
 *      `GET /api/users/me` (isBusiness, isSupplier, business). Covers
 *      business/supplier accounts created before the claims existed.
 *      `GET /api/channel/user` gives the caller's channel api keys — NOT to
 *      decide the kind, but to CLAIM a sponsor that already exists with one
 *      of those keys (created by hand before accounts were unified), so the
 *      business is linked to it instead of getting a duplicate.
 *
 * Having channels in Commerce does NOT mean seller: businesses connect
 * channels too (the webapp's Channels section is for every account).
 */

import type { FirebaseIdentity } from "../middleware/firebase-auth";

export type CommerceAccountKind = "seller" | "business" | "both" | "none";

export interface CommerceProfile {
  /** Commerce `user.id` — stored as users.reachu_user_id. */
  commerceUserId: number | null;
  isBusiness: boolean;
  isSupplier: boolean;
  brandName: string | null;
  /** Raw api keys of the caller's channels (in memory only, never stored). */
  channelApiKeys: string[];
}

export type CommerceProfileLookup = (idToken: string) => Promise<CommerceProfile | null>;

export function accountKind(identity: FirebaseIdentity, profile: CommerceProfile | null): CommerceAccountKind {
  const claims = identity.claims ?? {};
  const seller = claims.channel === true;
  const business = claims.business === true || profile?.isBusiness === true || profile?.isSupplier === true;
  if (seller && business) return "both";
  if (seller) return "seller";
  if (business) return "business";
  return "none";
}

/** Display name for an auto-created sponsor. */
export function brandNameFor(identity: FirebaseIdentity, profile: CommerceProfile | null): string {
  const name =
    identity.claims?.brandName?.trim() ||
    profile?.brandName?.trim() ||
    identity.name?.trim() ||
    identity.email ||
    identity.uid;
  return name.slice(0, 255); // sponsors.name is varchar(255)
}

/** base-api answers the channel list as an array, or wrapped in `data`. */
export function channelApiKeysFrom(payload: unknown): string[] {
  const p = payload as any;
  const rows: any[] = Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];
  const keys = rows
    .map((r) => r?.userChannelApiKey?.apiKey)
    .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    .map((k) => k.trim());
  return Array.from(new Set(keys));
}

async function getJson(url: string, idToken: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, {
    // base-api reads the raw Firebase token from `authorization` (no "Bearer").
    headers: { authorization: idToken },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

export function createCommerceProfileLookup(opts: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CommerceProfileLookup {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  return async (idToken) => {
    try {
      const [me, channels] = await Promise.all([
        getJson(`${base}/api/users/me`, idToken, doFetch, timeoutMs) as Promise<Record<string, any>>,
        // Best-effort: without keys we just cannot claim an existing sponsor.
        getJson(`${base}/api/channel/user`, idToken, doFetch, timeoutMs).catch((err) => {
          console.warn("[commerce-account] channel lookup failed:", (err as Error).message);
          return null;
        }),
      ]);
      const id = Number(me?.id);
      return {
        commerceUserId: Number.isInteger(id) && id > 0 ? id : null,
        isBusiness: me?.isBusiness === true,
        isSupplier: me?.isSupplier === true,
        brandName:
          (typeof me?.brandName === "string" && me.brandName) ||
          (typeof me?.business?.businessName === "string" && me.business.businessName) ||
          null,
        channelApiKeys: channelApiKeysFrom(channels),
      };
    } catch (err) {
      // Commerce down or the token rejected there: fall back to the claims.
      console.warn("[commerce-account] profile lookup failed:", (err as Error).message);
      return null;
    }
  };
}

/** Env-driven lookup; null when COMMERCE_API_URL (base-api host) is unset. */
export function envCommerceProfileLookup(): CommerceProfileLookup | null {
  const baseUrl = process.env.COMMERCE_API_URL;
  return baseUrl ? createCommerceProfileLookup({ baseUrl }) : null;
}
