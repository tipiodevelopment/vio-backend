import {
  resolveResourceOwnerId,
  createOwnershipGuard,
  type OwnershipStore,
} from "../server/middleware/resource-ownership";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

// Fixed test data: campaign 5 + its broadcast/poll/contest/scheduled-component
// all belong to owner 7; client-app 9, sponsor 3 → owner 7. Owner 8 owns nothing.
function store(): OwnershipStore {
  return {
    getClientApp: async (id) => (id === 9 ? { userId: 7 } : undefined),
    getCampaign: async (id) => (id === 5 ? { userId: 7 } : undefined),
    getSponsor: async (id) => (id === 3 ? { userId: 7 } : undefined),
    getBroadcast: async (bid) => (bid === "bc-1" ? { campaignId: 5 } : bid === "orphan" ? { campaignId: null } : undefined),
    getPoll: async (id) => (id === 11 ? { broadcastId: "bc-1" } : undefined),
    getContest: async (id) => (id === 22 ? { broadcastId: "bc-1" } : undefined),
    getScheduledComponent: async (id) => (id === 33 ? { campaignId: 5 } : undefined),
  };
}

describe("resolveResourceOwnerId", () => {
  const s = store();

  it("resolves direct-owner resources", async () => {
    await expect(resolveResourceOwnerId(s, "/api/client-apps/9")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/client-apps/9/placements")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/campaigns/5")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/campaigns/5/components/abc")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/sponsors/3")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/events/5")).resolves.toBe(7);
  });

  it("resolves resources via the broadcast → campaign chain", async () => {
    await expect(resolveResourceOwnerId(s, "/api/broadcasts/bc-1")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/broadcasts/bc-1/polls")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/polls/11")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/contests/22")).resolves.toBe(7);
    await expect(resolveResourceOwnerId(s, "/api/scheduled-components/33")).resolves.toBe(7);
  });

  it("returns undefined when the resource (or a parent) does not exist", async () => {
    await expect(resolveResourceOwnerId(s, "/api/campaigns/999")).resolves.toBeUndefined();
    await expect(resolveResourceOwnerId(s, "/api/polls/999")).resolves.toBeUndefined();
    await expect(resolveResourceOwnerId(s, "/api/broadcasts/orphan")).resolves.toBeUndefined(); // no campaignId
  });

  it("returns undefined for non-guarded / non-id paths", async () => {
    await expect(resolveResourceOwnerId(s, "/api/campaigns")).resolves.toBeUndefined();
    await expect(resolveResourceOwnerId(s, "/api/campaigns/broadcast-counts")).resolves.toBeUndefined();
    await expect(resolveResourceOwnerId(s, "/api/client-apps/with-stats")).resolves.toBeUndefined();
    await expect(resolveResourceOwnerId(s, "/api/components/abc")).resolves.toBeUndefined(); // global library
    await expect(resolveResourceOwnerId(s, "/api/broadcasts/ads/1")).resolves.toBeUndefined(); // sub-collection, not a broadcastId
    await expect(resolveResourceOwnerId(s, "/api/auth/users/4")).resolves.toBeUndefined();
  });
});

describe("createOwnershipGuard", () => {
  const guard = createOwnershipGuard(store());
  const mk = (operator: any, method: string, path: string) => {
    const req: any = { operator, method, baseUrl: "/api", path: path.replace(/^\/api/, "") };
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    const next = jest.fn();
    return { req, res, next };
  };

  it("passes through with no operator (public/no session)", async () => {
    const { req, res, next } = mk(undefined, "GET", "/api/campaigns/5");
    await guard(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("super_admin bypasses ownership", async () => {
    const { req, res, next } = mk({ id: 1, role: "super_admin", parentAdminId: null }, "PATCH", "/api/campaigns/5");
    await guard(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("admin reaching its OWN resource passes", async () => {
    const { req, res, next } = mk({ id: 7, role: "admin", parentAdminId: null }, "PATCH", "/api/campaigns/5");
    await guard(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("admin reaching ANOTHER tenant's resource is 403'd", async () => {
    const { req, res, next } = mk({ id: 8, role: "admin", parentAdminId: null }, "PATCH", "/api/campaigns/5");
    await guard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("operator is scoped to its parent admin's resources", async () => {
    // /stats is not public (only the bare GET /api/campaigns/:id is), so the
    // ownership check actually runs here.
    const ok = mk({ id: 12, role: "operator", parentAdminId: 7 }, "GET", "/api/campaigns/5/stats");
    await guard(ok.req, ok.res, ok.next);
    expect(ok.next).toHaveBeenCalled();

    const bad = mk({ id: 12, role: "operator", parentAdminId: 8 }, "GET", "/api/campaigns/5/stats");
    await guard(bad.req, bad.res, bad.next);
    expect(bad.res.status).toHaveBeenCalledWith(403);
  });

  it("falls through for a missing resource (handler 404s, not 403)", async () => {
    const { req, res, next } = mk({ id: 8, role: "admin", parentAdminId: null }, "GET", "/api/campaigns/999");
    await guard(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("skips the public campaign-viewer GET even for a logged-in operator", async () => {
    const { req, res, next } = mk({ id: 8, role: "admin", parentAdminId: null }, "GET", "/api/campaigns/5");
    await guard(req, res, next);
    expect(next).toHaveBeenCalled(); // GET /api/campaigns/:id is public → not ownership-checked
  });
});
