import express from "express";
import request from "supertest";
import { createApiGate, createSessionToken, SESSION_COOKIE } from "../server/middleware/authz";
import { createOwnershipGuard, type OwnershipStore } from "../server/middleware/resource-ownership";
import { readScopeOwnerId } from "../server/middleware/capabilities";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

// Operators the gate's loadOperator resolves. id 99 = stale (deleted) cookie.
const OPERATORS: Record<number, any> = {
  1: { id: 1, role: "super_admin", parentAdminId: null },
  7: { id: 7, role: "admin", parentAdminId: null },        // admin A
  8: { id: 8, role: "admin", parentAdminId: null },        // admin B
  9: { id: 9, role: "operator", parentAdminId: 7 },        // operator under A
  10: { id: 10, role: "viewer", parentAdminId: 7 },        // viewer under A
};

// campaign 100 → owner A(7); campaign 200 → owner B(8).
const store: OwnershipStore = {
  getCampaign: async (id) => (id === 100 ? { userId: 7 } : id === 200 ? { userId: 8 } : undefined),
  getClientApp: async () => undefined,
  getSponsor: async () => undefined,
  getBroadcast: async () => undefined,
  getPoll: async () => undefined,
  getContest: async () => undefined,
  getScheduledComponent: async () => undefined,
};

function buildApp() {
  const app = express();
  app.use(express.json());

  // Gate + ownership guard, mounted exactly as routes.ts does.
  app.use("/api", createApiGate({ loadOperator: async (id) => OPERATORS[id] }));
  app.use("/api", createOwnershipGuard(store));

  // Representative routes. If a request reaches the handler, the middleware let it.
  app.get("/api/status", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/token", (_req, res) => res.json({ token: "x" }));
  app.post("/api/checkout/confirm-apple-pay", (_req, res) => res.json({ reached: true }));
  app.get("/api/campaigns", (req, res) => res.json({ scope: readScopeOwnerId((req as any).operator) }));
  app.get("/api/campaigns/:id", (_req, res) => res.json({ public: true }));
  app.get("/api/campaigns/:id/stats", (_req, res) => res.json({ reached: true }));
  app.post("/api/campaigns", (_req, res) => res.json({ created: true }));
  app.post("/api/client-apps", (_req, res) => res.json({ created: true }));
  app.get("/api/auth/users", (_req, res) => res.json({ reached: true }));
  return app;
}

const app = buildApp();
const cookie = (id: number) => `${SESSION_COOKIE}=${createSessionToken(id)}`;

describe("auth chain — gate + ownership (integration)", () => {
  describe("session / public surface", () => {
    it("401 on a protected route without a session", async () => {
      await request(app).get("/api/campaigns").expect(401);
    });
    it("public routes need no session", async () => {
      await request(app).get("/api/status").expect(200);
      await request(app).post("/api/auth/token").expect(200);
      await request(app).get("/api/campaigns/100").expect(200); // public bare GET
    });
    it("apiKey-exempt endpoint is reachable past the operator gate (no session)", async () => {
      const res = await request(app).post("/api/checkout/confirm-apple-pay").expect(200);
      expect(res.body.reached).toBe(true);
    });
    it("401 + clears the cookie when the operator row is gone (stale)", async () => {
      const res = await request(app).get("/api/campaigns").set("Cookie", cookie(99)).expect(401);
      expect(String(res.headers["set-cookie"] ?? "")).toContain(SESSION_COOKIE);
    });
  });

  describe("capabilities", () => {
    it("super_admin lists with no filter (scope null = all)", async () => {
      const res = await request(app).get("/api/campaigns").set("Cookie", cookie(1)).expect(200);
      expect(res.body.scope).toBeNull();
    });
    it("admin lists scoped to itself", async () => {
      const res = await request(app).get("/api/campaigns").set("Cookie", cookie(7)).expect(200);
      expect(res.body.scope).toBe(7);
    });
    it("operator lists scoped to its parent admin", async () => {
      const res = await request(app).get("/api/campaigns").set("Cookie", cookie(9)).expect(200);
      expect(res.body.scope).toBe(7);
    });
    it("viewer cannot read campaigns (lacks campaigns:read)", async () => {
      await request(app).get("/api/campaigns").set("Cookie", cookie(10)).expect(403);
    });
    it("operator can create a campaign but not an app", async () => {
      await request(app).post("/api/campaigns").set("Cookie", cookie(9)).send({}).expect(200);
      await request(app).post("/api/client-apps").set("Cookie", cookie(9)).send({}).expect(403);
    });
    it("only super_admin manages users", async () => {
      await request(app).get("/api/auth/users").set("Cookie", cookie(7)).expect(403);
      await request(app).get("/api/auth/users").set("Cookie", cookie(1)).expect(200);
    });
  });

  describe("per-resource tenant ownership", () => {
    it("admin reaches its own campaign's sub-resource", async () => {
      await request(app).get("/api/campaigns/100/stats").set("Cookie", cookie(7)).expect(200);
    });
    it("admin is 403'd on another tenant's campaign by id", async () => {
      await request(app).get("/api/campaigns/200/stats").set("Cookie", cookie(7)).expect(403);
    });
    it("operator inherits its admin's tenant for ownership", async () => {
      await request(app).get("/api/campaigns/100/stats").set("Cookie", cookie(9)).expect(200);
      await request(app).get("/api/campaigns/200/stats").set("Cookie", cookie(9)).expect(403);
    });
    it("super_admin bypasses ownership", async () => {
      await request(app).get("/api/campaigns/200/stats").set("Cookie", cookie(1)).expect(200);
    });
    it("the public bare GET is not ownership-checked, even cross-tenant", async () => {
      await request(app).get("/api/campaigns/200").set("Cookie", cookie(7)).expect(200);
    });
  });
});
