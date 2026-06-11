import type { User } from "@shared/schema";

// Capability model (ADR-0007). Two orthogonal questions:
//   1. CAN this role perform this kind of action?      → capabilities (this file)
//   2. On WHOSE data?                                   → ownerScope (this file)
//
// The matrix is intentionally coarse for v1 — we expand it step by step as we
// define each role's abilities. To grant a role a new ability, add the
// Capability and list it under that role. Nothing else needs to change.

export type Role = User["role"];

export type Capability =
  | "apps:read"
  | "apps:create"
  | "apps:write"
  | "sponsors:read"
  | "sponsors:write"
  | "campaigns:read"
  | "campaigns:create"
  | "campaigns:write"
  | "users:manage";

export const ALL_CAPABILITIES: Capability[] = [
  "apps:read", "apps:create", "apps:write",
  "sponsors:read", "sponsors:write",
  "campaigns:read", "campaigns:create", "campaigns:write",
  "users:manage",
];

// v1 starting point (owner decision 2026-06-10):
//   super_admin → everything, global.
//   admin       → owns its tenant: its apps + sponsors + their campaigns.
//   operator    → for now ONLY create campaigns (+ read what it needs to).
//   viewer      → read its sponsor, nothing else.
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  super_admin: ALL_CAPABILITIES,
  admin: [
    "apps:read", "apps:create", "apps:write",
    "sponsors:read", "sponsors:write",
    "campaigns:read", "campaigns:create", "campaigns:write",
  ],
  operator: ["apps:read", "campaigns:read", "campaigns:create"],
  viewer: ["sponsors:read"],
};

export function can(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}

// Maps an /api request (full path incl. /api prefix) to the capability it
// requires. Explicit groups for apps/sponsors/campaigns/users; everything
// else falls back to campaigns:read (reads) / campaigns:write (mutations) so
// the long tail stays admin+ until we classify it.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requiredCapabilityFor(method: string, path: string): Capability {
  const m = method.toUpperCase();
  const mutating = MUTATING.has(m);
  const clean = path.replace(/\/+$/, "");

  if (/^\/api\/(auth\/users|users)(\/|$)/.test(clean)) return "users:manage";

  if (/^\/api\/client-apps(\/|$)/.test(clean)) {
    if (m === "POST" && clean === "/api/client-apps") return "apps:create";
    return mutating ? "apps:write" : "apps:read";
  }

  if (/^\/api\/sponsors(\/|$)/.test(clean)) {
    return mutating ? "sponsors:write" : "sponsors:read";
  }

  if (/^\/api\/campaigns(\/|$)/.test(clean)) {
    if (m === "POST" && clean === "/api/campaigns") return "campaigns:create";
    return mutating ? "campaigns:write" : "campaigns:read";
  }

  return mutating ? "campaigns:write" : "campaigns:read";
}

// ── Data ownership scope ─────────────────────────────────────────────────
// Which owner's (user_id) rows this operator may see/touch.
//   super_admin → all rows.
//   admin       → rows it owns (user_id = its own id).
//   operator/viewer → rows owned by their admin (parent_admin_id).

export type OwnerScope = { all: true } | { ownerId: number };

export function ownerScope(
  operator: Pick<User, "id" | "role" | "parentAdminId">,
): OwnerScope {
  if (operator.role === "super_admin") return { all: true };
  if (operator.role === "admin") return { ownerId: operator.id };
  return { ownerId: operator.parentAdminId ?? operator.id };
}

type ScopeOperator = Pick<User, "id" | "role" | "parentAdminId">;

// Reads: which owner's rows the operator may see in a LIST — null = all
// (super_admin); otherwise the tenant owner id.
export function readScopeOwnerId(operator: ScopeOperator | undefined): number | null {
  if (!operator) return null;
  const scope = ownerScope(operator);
  return "all" in scope ? null : scope.ownerId;
}

// Creates: the user_id a newly-created row belongs to. super_admin may target a
// specific admin via body.userId (that's how it assigns); everyone else is
// forced to their own tenant owner — a client cannot create on another's behalf.
export function createOwnerId(operator: ScopeOperator | undefined, bodyUserId?: unknown): number {
  if (operator && operator.role === "super_admin" && typeof bodyUserId === "number") return bodyUserId;
  if (!operator) return typeof bodyUserId === "number" ? bodyUserId : 0;
  const scope = ownerScope(operator);
  return "all" in scope ? operator.id : scope.ownerId;
}
