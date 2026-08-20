/**
 * Dashboard → vio-analytics stats proxy (F6, read side).
 *
 * The collector (`vio-live/vio-analytics`) exposes tenant-scoped aggregates
 * at `/v1/stats/*`, authenticated by api key (scope = ONE client_app) or by
 * the internal service token (caller names the tenant after doing its own
 * authz). The dashboard needs the second path: an operator may own several
 * apps, and their identity lives HERE, not in the collector.
 *
 * This proxy is that bridge:
 *   1. Validates the requested clientAppId belongs to the requesting user
 *      (same `userId` scoping model as the rest of `/api` today — when the
 *      ADR-0008 session/capability gate lands, it slots in front of this
 *      without changing the proxy).
 *   2. Forwards to the collector with `X-Internal-Token`, naming the tenant.
 *
 * The collector stays 100% ignorant of Vio operators/roles — independence
 * is preserved; the dependency arrow is backend → collector only.
 *
 * Config (same envs as the outbox mirror — already set on ca-api-vio-*):
 *   ANALYTICS_EVENTS_URL      collector base for THIS environment
 *   ANALYTICS_INTERNAL_TOKEN  shared secret
 * Unset → 503 with a clear message (dashboards can hide the section).
 *
 * Routes:
 *   GET /api/analytics/vio/overview?userId&clientAppId&days
 *   GET /api/analytics/vio/components?userId&clientAppId&days[&campaignId]
 *   GET /api/analytics/vio/campaigns/:campaignId/funnel?userId&clientAppId&days
 */

import type { Express, Request, Response } from "express";
import type { IStorage } from "./storage";

interface ProxyDeps {
  storage: IStorage;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function collectorConfig(): { base: string; token: string } | null {
  const base = process.env.ANALYTICS_EVENTS_URL;
  const token = process.env.ANALYTICS_INTERNAL_TOKEN;
  if (!base || !token) return null;
  return { base: base.replace(/\/$/, ""), token };
}

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(n)));
}

/**
 * Shared gate: parse userId/clientAppId, verify ownership, return the
 * pieces every route needs — or null after replying with the error.
 */
async function authorize(
  req: Request,
  res: Response,
  storage: IStorage,
): Promise<{ clientAppId: number; days: number } | null> {
  const userId = Number(req.query.userId);
  const clientAppId = Number(req.query.clientAppId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "userId is required" });
    return null;
  }
  if (!Number.isInteger(clientAppId) || clientAppId <= 0) {
    res.status(400).json({ error: "clientAppId is required" });
    return null;
  }
  // Ownership: the app must belong to the requesting user. This is the
  // whole point of the proxy — the collector trusts US to have done this.
  const apps = await storage.getUserClientApps(userId);
  if (!apps.some((app) => app.id === clientAppId)) {
    res.status(403).json({ error: "clientAppId does not belong to this user" });
    return null;
  }
  return { clientAppId, days: clampDays(req.query.days) };
}

export function registerVioAnalyticsProxy(app: Express, deps: ProxyDeps): void {
  const doFetch = deps.fetchImpl ?? fetch;

  const forward = async (res: Response, path: string, params: Record<string, string>) => {
    const cfg = collectorConfig();
    if (!cfg) {
      return res.status(503).json({
        error: "analytics collector not configured",
        hint: "set ANALYTICS_EVENTS_URL and ANALYTICS_INTERNAL_TOKEN",
      });
    }
    const qs = new URLSearchParams(params).toString();
    try {
      const upstream = await doFetch(`${cfg.base}${path}?${qs}`, {
        headers: { "X-Internal-Token": cfg.token },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(body);
    } catch (err) {
      console.error("[analytics-proxy] collector unreachable:", err);
      return res.status(502).json({ error: "analytics collector unreachable" });
    }
  };

  app.get("/api/analytics/vio/overview", async (req, res) => {
    try {
      const auth = await authorize(req, res, deps.storage);
      if (!auth) return;
      await forward(res, "/v1/stats/overview", {
        client_app_id: String(auth.clientAppId),
        days: String(auth.days),
      });
    } catch (err) {
      console.error("[analytics-proxy] overview failed:", err);
      res.status(500).json({ error: "failed to fetch analytics overview" });
    }
  });

  app.get("/api/analytics/vio/components", async (req, res) => {
    try {
      const auth = await authorize(req, res, deps.storage);
      if (!auth) return;
      const params: Record<string, string> = {
        client_app_id: String(auth.clientAppId),
        days: String(auth.days),
      };
      const campaignId = Number(req.query.campaignId);
      if (Number.isInteger(campaignId) && campaignId > 0) {
        params.campaignId = String(campaignId);
      }
      await forward(res, "/v1/stats/components", params);
    } catch (err) {
      console.error("[analytics-proxy] components failed:", err);
      res.status(500).json({ error: "failed to fetch component stats" });
    }
  });

  app.get("/api/analytics/vio/campaigns/:campaignId/funnel", async (req, res) => {
    try {
      const auth = await authorize(req, res, deps.storage);
      if (!auth) return;
      const campaignId = Number(req.params.campaignId);
      if (!Number.isInteger(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: "invalid campaignId" });
      }
      // The campaign must live inside the authorized app — no peeking at
      // another tenant's campaign through your own app id.
      const campaign = await deps.storage.getCampaign(campaignId);
      if (!campaign || campaign.clientAppId !== auth.clientAppId) {
        return res.status(404).json({ error: "campaign not found in this app" });
      }
      await forward(res, `/v1/stats/campaigns/${campaignId}/funnel`, {
        client_app_id: String(auth.clientAppId),
        days: String(auth.days),
      });
    } catch (err) {
      console.error("[analytics-proxy] funnel failed:", err);
      res.status(500).json({ error: "failed to fetch campaign funnel" });
    }
  });
}
