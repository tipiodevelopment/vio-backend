import {
  can,
  requiredCapabilityFor,
  ownerScope,
  readScopeOwnerId,
  createOwnerId,
  ROLE_CAPABILITIES,
} from "../server/middleware/capabilities";

const SUPER = { id: 1, role: "super_admin" as const, parentAdminId: null };
const ADMIN = { id: 7, role: "admin" as const, parentAdminId: null };
const OPERATOR = { id: 9, role: "operator" as const, parentAdminId: 7 };

describe("role → capabilities (ADR-0007 v1)", () => {
  it("super_admin can do everything", () => {
    expect(can("super_admin", "users:manage")).toBe(true);
    expect(can("super_admin", "apps:create")).toBe(true);
    expect(can("super_admin", "campaigns:write")).toBe(true);
    expect(can("super_admin", "sponsors:write")).toBe(true);
  });

  it("admin owns its tenant but cannot manage users", () => {
    expect(can("admin", "apps:create")).toBe(true);
    expect(can("admin", "apps:write")).toBe(true);
    expect(can("admin", "sponsors:write")).toBe(true);
    expect(can("admin", "campaigns:write")).toBe(true);
    expect(can("admin", "users:manage")).toBe(false);
  });

  it("operator can only create campaigns (v1) — not write apps/sponsors", () => {
    expect(can("operator", "campaigns:create")).toBe(true);
    expect(can("operator", "campaigns:read")).toBe(true);
    expect(can("operator", "apps:read")).toBe(true);
    expect(can("operator", "campaigns:write")).toBe(false);
    expect(can("operator", "apps:create")).toBe(false);
    expect(can("operator", "sponsors:write")).toBe(false);
  });

  it("viewer can only read sponsors", () => {
    expect(can("viewer", "sponsors:read")).toBe(true);
    expect(can("viewer", "campaigns:read")).toBe(false);
    expect(can("viewer", "apps:read")).toBe(false);
    expect(can("viewer", "campaigns:create")).toBe(false);
  });
});

describe("requiredCapabilityFor", () => {
  it("maps user management to users:manage", () => {
    expect(requiredCapabilityFor("GET", "/api/auth/users")).toBe("users:manage");
    expect(requiredCapabilityFor("DELETE", "/api/auth/users/4")).toBe("users:manage");
  });

  it("distinguishes app create from app write and read", () => {
    expect(requiredCapabilityFor("POST", "/api/client-apps")).toBe("apps:create");
    expect(requiredCapabilityFor("PATCH", "/api/client-apps/3")).toBe("apps:write");
    expect(requiredCapabilityFor("GET", "/api/client-apps")).toBe("apps:read");
    expect(requiredCapabilityFor("GET", "/api/client-apps/3/channels")).toBe("apps:read");
  });

  it("distinguishes campaign create from campaign write and read", () => {
    expect(requiredCapabilityFor("POST", "/api/campaigns")).toBe("campaigns:create");
    expect(requiredCapabilityFor("POST", "/api/campaigns/3/components")).toBe("campaigns:write");
    expect(requiredCapabilityFor("PATCH", "/api/campaigns/3")).toBe("campaigns:write");
    expect(requiredCapabilityFor("GET", "/api/campaigns")).toBe("campaigns:read");
  });

  it("maps sponsors by read/write", () => {
    expect(requiredCapabilityFor("GET", "/api/sponsors")).toBe("sponsors:read");
    expect(requiredCapabilityFor("DELETE", "/api/sponsors/3")).toBe("sponsors:write");
  });

  it("defaults the long tail to campaign read/write", () => {
    expect(requiredCapabilityFor("GET", "/api/broadcasts")).toBe("campaigns:read");
    expect(requiredCapabilityFor("PATCH", "/api/broadcasts/9")).toBe("campaigns:write");
  });
});

describe("ownerScope (tenancy)", () => {
  it("super_admin sees all", () => {
    expect(ownerScope({ id: 5, role: "super_admin", parentAdminId: null })).toEqual({ all: true });
  });

  it("admin is scoped to itself", () => {
    expect(ownerScope({ id: 7, role: "admin", parentAdminId: null })).toEqual({ ownerId: 7 });
  });

  it("operator/viewer are scoped to their parent admin", () => {
    expect(ownerScope({ id: 9, role: "operator", parentAdminId: 7 })).toEqual({ ownerId: 7 });
    expect(ownerScope({ id: 10, role: "viewer", parentAdminId: 7 })).toEqual({ ownerId: 7 });
  });

  it("falls back to self when an operator has no parent (defensive)", () => {
    expect(ownerScope({ id: 9, role: "operator", parentAdminId: null })).toEqual({ ownerId: 9 });
  });
});

describe("readScopeOwnerId (list scoping)", () => {
  it("super_admin → null (no filter, sees all)", () => {
    expect(readScopeOwnerId(SUPER)).toBeNull();
  });
  it("admin → its own id", () => {
    expect(readScopeOwnerId(ADMIN)).toBe(7);
  });
  it("operator → its parent admin", () => {
    expect(readScopeOwnerId(OPERATOR)).toBe(7);
  });
  it("no operator → null", () => {
    expect(readScopeOwnerId(undefined)).toBeNull();
  });
});

describe("createOwnerId (owner-on-create)", () => {
  it("admin's new rows belong to the admin (body.userId ignored)", () => {
    expect(createOwnerId(ADMIN, 999)).toBe(7);
  });
  it("operator's new rows belong to its parent admin (cannot target another)", () => {
    expect(createOwnerId(OPERATOR, 999)).toBe(7);
  });
  it("super_admin may target a specific admin via body.userId", () => {
    expect(createOwnerId(SUPER, 42)).toBe(42);
  });
  it("super_admin without body.userId owns it itself", () => {
    expect(createOwnerId(SUPER)).toBe(1);
  });
});

describe("capability matrix is internally consistent", () => {
  it("every listed capability is a known capability", () => {
    const known = new Set([
      "apps:read", "apps:create", "apps:write",
      "sponsors:read", "sponsors:write",
      "campaigns:read", "campaigns:create", "campaigns:write",
      "users:manage",
    ]);
    for (const caps of Object.values(ROLE_CAPABILITIES)) {
      for (const c of caps) expect(known.has(c)).toBe(true);
    }
  });
});
