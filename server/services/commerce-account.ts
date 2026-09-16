/**
 * What kind of Commerce account is calling (2026-09-16).
 *
 * Commerce is the only place that creates accounts; Vio provisions its own
 * user on the first Firebase-bearer call from what Commerce says the account
 * is:
 *
 *   seller            (has / creates channels)        → Vio `admin`: owns its surfaces
 *   business|supplier (owns the products)             → Vio `sponsor` + its sponsor row
 *   both, or neither  → not provisioned (403)
 *
 * Two sources, cheapest first:
 *   1. The ID token's custom claims, set at signup by vio-users-microservice
 *      (`business`, `channel`, `brand_name`). Best-effort there, and the
 *      `channel` flag exists ONLY as a claim (no DB column).
 *   2. Commerce itself, with the same token, when COMMERCE_API_URL is set:
 *      `GET /api/users/me` (isBusiness, isSupplier, business) and
 *      `GET /api/channel/user` (the caller's channels — having one = seller).
 *      Covers accounts created before the claims existed.
 */

import type { FirebaseIdentity } from "../middleware/firebase-auth";

export type CommerceAccountKind = "seller" | "business" | "both" | "none";

export interface CommerceProfile {
  /** Commerce `user.id` — stored as users.reachu_user_id. */
  commerceUserId: number | null;
  isBusiness: boolean;
  isSupplier: boolean;
  channelCount: number;
  brandName: string | null;
}

export type CommerceProfileLookup = (idToken: string) => Promise<CommerceProfile | null>;

export function accountKind(identity: FirebaseIdentity, profile: CommerceProfile | null): CommerceAccountKind {
  const claims = identity.claims ?? {};
  const seller = claims.channel === true || (profile?.channelCount ?? 0) > 0;
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
        getJson(`${base}/api/channel/user`, idToken, doFetch, timeoutMs),
      ]);
      const id = Number(me?.id);
      return {
        commerceUserId: Number.isInteger(id) && id > 0 ? id : null,
        isBusiness: me?.isBusiness === true,
        isSupplier: me?.isSupplier === true,
        channelCount: Array.isArray(channels) ? channels.length : 0,
        brandName:
          (typeof me?.brandName === "string" && me.brandName) ||
          (typeof me?.business?.businessName === "string" && me.business.businessName) ||
          null,
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
