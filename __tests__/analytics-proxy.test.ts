/**
 * Dashboard stats proxy — authz gate + forwarding semantics. No DB, no
 * network: fake storage + fake fetch, real Express request path.
 */

import express from "express";
import request from "supertest";
import { registerVioAnalyticsProxy } from "../server/analytics-proxy";
import type { IStorage } from "../server/storage";

const USER = 7;
const APP = 17;
const OTHER_APP = 99;
const CAMPAIGN = 44;

function buildApp(configured = true) {
  if (configured) {
    process.env.ANALYTICS_EVENTS_URL = "https://events-test.vio.live";
    process.env.ANALYTICS_INTERNAL_TOKEN = "internal-test-token";
  } else {
    delete process.env.ANALYTICS_EVENTS_URL;
    delete process.env.ANALYTICS_INTERNAL_TOKEN;
  }

  const calls: Array<{ url: string; token: string | undefined }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      token: (init?.headers as Record<string, string>)?.["X-Internal-Token"],
    });
    return {
      status: 200,
      json: async () => ({ ok: true, from: "collector" }),
    } as Response;
  }) as typeof fetch;

  const storage = {
    getUserClientApps: jest.fn(async (userId: number) =>
      userId === USER ? [{ id: APP }] : [],
    ),
    getCampaign: jest.fn(async (id: number) =>
      id === CAMPAIGN ? { id, clientAppId: APP } : undefined,
    ),
  } as unknown as IStorage;

  const app = express();
  registerVioAnalyticsProxy(app, { storage, fetchImpl });
  return { app, calls, storage };
}

describe("GET /api/analytics/vio/* — authz gate", () => {
  it("400 without userId or clientAppId", async () => {
    const { app } = buildApp();
    expect((await request(app).get("/api/analytics/vio/overview")).status).toBe(400);
    expect(
      (await request(app).get("/api/analytics/vio/overview?userId=7")).status,
    ).toBe(400);
  });

  it("403 when the app does not belong to the user", async () => {
    const { app, calls } = buildApp();
    const res = await request(app).get(
      `/api/analytics/vio/overview?userId=${USER}&clientAppId=${OTHER_APP}`,
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0); // never reaches the collector
  });

  it("forwards authorized requests with the internal token and resolved tenant", async () => {
    const { app, calls } = buildApp();
    const res = await request(app).get(
      `/api/analytics/vio/overview?userId=${USER}&clientAppId=${APP}&days=7`,
    );
    expect(res.status).toBe(200);
    expect(res.body.from).toBe("collector");
    expect(calls[0].url).toContain("/v1/stats/overview");
    expect(calls[0].url).toContain(`client_app_id=${APP}`);
    expect(calls[0].url).toContain("days=7");
    expect(calls[0].token).toBe("internal-test-token");
  });

  it("clamps days into [1,365]", async () => {
    const { app, calls } = buildApp();
    await request(app).get(
      `/api/analytics/vio/overview?userId=${USER}&clientAppId=${APP}&days=99999`,
    );
    expect(calls[0].url).toContain("days=365");
  });
});

describe("campaign funnel — cross-tenant protection", () => {
  it("404 when the campaign lives in another app", async () => {
    const { app, storage, calls } = buildApp();
    (storage.getCampaign as jest.Mock).mockResolvedValueOnce({
      id: CAMPAIGN,
      clientAppId: OTHER_APP, // belongs to someone else
    });
    const res = await request(app).get(
      `/api/analytics/vio/campaigns/${CAMPAIGN}/funnel?userId=${USER}&clientAppId=${APP}`,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("forwards a legitimate campaign funnel", async () => {
    const { app, calls } = buildApp();
    const res = await request(app).get(
      `/api/analytics/vio/campaigns/${CAMPAIGN}/funnel?userId=${USER}&clientAppId=${APP}`,
    );
    expect(res.status).toBe(200);
    expect(calls[0].url).toContain(`/v1/stats/campaigns/${CAMPAIGN}/funnel`);
  });
});

describe("collector not configured", () => {
  it("503 with a clear hint (dashboards can hide the section)", async () => {
    const { app } = buildApp(false);
    const res = await request(app).get(
      `/api/analytics/vio/overview?userId=${USER}&clientAppId=${APP}`,
    );
    expect(res.status).toBe(503);
    expect(res.body.hint).toContain("ANALYTICS_EVENTS_URL");
  });
});
