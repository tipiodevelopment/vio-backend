import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { User } from "@shared/schema";
import { ownerScope } from "./capabilities";
import { isPublicApiPath } from "./authz";

// Per-resource tenant ownership (ADR-0008). The capability gate answers "may
// this role do this kind of action"; this guard answers "is *this specific*
// resource in the operator's tenant" — closing the hole where an admin with
// e.g. campaigns:read could read another tenant's campaign by id.
//
// Design: it only ever 403s when it POSITIVELY resolves an existing resource
// owned by another tenant. Unknown paths, missing resources, and resources
// with no resolvable owner all fall through to the handler (which 404s as
// usual) — so the guard can never block a legitimate request by mistake.

// Minimal shapes we read. `storage` satisfies this structurally.
export interface OwnershipStore {
  getClientApp(id: number): Promise<{ userId: number } | undefined>;
  getCampaign(id: number): Promise<{ userId: number } | undefined>;
  getSponsor(id: number): Promise<{ userId: number } | undefined>;
  getBroadcast(broadcastId: string): Promise<{ campaignId: number | null } | undefined>;
  getPoll(id: number): Promise<{ broadcastId: string } | undefined>;
  getContest(id: number): Promise<{ broadcastId: string } | undefined>;
  getScheduledComponent(id: number): Promise<{ campaignId: number } | undefined>;
}

/**
 * The owning `user_id` of the tenant resource a request targets, or `undefined`
 * when the path isn't a guarded resource, or the resource (or a parent in its
 * chain) doesn't exist. Components are intentionally absent — the components
 * table is a global library, not tenant-owned.
 */
export async function resolveResourceOwnerId(
  store: OwnershipStore,
  path: string,
): Promise<number | undefined> {
  let m: RegExpMatchArray | null;

  // Direct owner (user_id on the row).
  if ((m = path.match(/^\/api\/client-apps\/(\d+)(\/|$)/))) return (await store.getClientApp(+m[1]))?.userId;
  if ((m = path.match(/^\/api\/campaigns\/(\d+)(\/|$)/))) return (await store.getCampaign(+m[1]))?.userId;
  if ((m = path.match(/^\/api\/events\/(\d+)(\/|$)/))) return (await store.getCampaign(+m[1]))?.userId;
  if ((m = path.match(/^\/api\/sponsors\/(\d+)(\/|$)/))) return (await store.getSponsor(+m[1]))?.userId;

  // Via campaign.
  if ((m = path.match(/^\/api\/scheduled-components\/(\d+)(\/|$)/))) {
    const sc = await store.getScheduledComponent(+m[1]);
    return sc ? (await store.getCampaign(sc.campaignId))?.userId : undefined;
  }

  // Via broadcast → campaign.
  const ownerViaBroadcast = async (broadcastId: string): Promise<number | undefined> => {
    const b = await store.getBroadcast(broadcastId);
    if (!b?.campaignId) return undefined;
    return (await store.getCampaign(b.campaignId))?.userId;
  };
  if ((m = path.match(/^\/api\/polls\/(\d+)(\/|$)/))) {
    const p = await store.getPoll(+m[1]);
    return p ? ownerViaBroadcast(p.broadcastId) : undefined;
  }
  if ((m = path.match(/^\/api\/contests\/(\d+)(\/|$)/))) {
    const ct = await store.getContest(+m[1]);
    return ct ? ownerViaBroadcast(ct.broadcastId) : undefined;
  }
  if ((m = path.match(/^\/api\/broadcasts\/([^/]+)(\/|$)/))) {
    // `ads`/`products` are sub-collections (`/api/broadcasts/ads/:id`), not
    // broadcastIds — not covered here (no getter); fall through.
    if (m[1] === "ads" || m[1] === "products") return undefined;
    return ownerViaBroadcast(m[1]);
  }

  return undefined;
}

export function createOwnershipGuard(store: OwnershipStore): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const operator = req.operator as User | undefined;
    if (!operator) return next(); // public route / no session — gate already decided

    const method = req.method.toUpperCase();
    const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "") || req.baseUrl;
    if (isPublicApiPath(method, path)) return next();

    const scope = ownerScope(operator);
    if ("all" in scope) return next(); // super_admin

    let ownerId: number | undefined;
    try {
      ownerId = await resolveResourceOwnerId(store, path);
    } catch {
      return next(); // resolver failure must not block — handler deals with it
    }
    if (ownerId === undefined) return next(); // not guarded, or resource absent

    if (ownerId !== scope.ownerId) {
      return res.status(403).json({ message: "Access denied: resource belongs to another tenant" });
    }
    next();
  };
}
