import "./env";
import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { storage } from "./storage";
import {
  webSocketEventSchema,
  updateCampaignSchema,
  componentSDKNames,
  insertBroadcastSchema,
  updateBroadcastSchema,
  insertPollSchema,
  insertPollOptionSchema,
  insertContestSchema,
  insertContestParticipationSchema,
  createPollInputSchema,
  createContestInputSchema,
  voteInputSchema,
  participateInputSchema,
  insertCampaignSponsorSchema,
  insertBroadcastSponsorSlotSchema,
  shoppableAdActivations,
  campaignComponents,
  components,
  appPlacements,
  appComponentLocations,
  polls,
  contests,
  sponsors,
  campaignSponsors,
  endUsers,
  tvSessions,
  cartIntents,
  users,
  type WebSocketEvent,
  type InsertScheduledComponent,
  Campaign,
  Broadcast,
  Sponsor,
  userRoleEnum,
  type User
} from "@shared/schema";
import { db } from "./db";
import { eq, and, or, isNull, desc, sql, ne } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "./objectStorage";
import { isCampaignActive, hasCampaignEnded, isCampaignUpcoming, normalizeUrls } from "./utils";
import { calculateScheduledTimes, validateScheduling } from "./utils/scheduling";
import { voteQueue, contestParticipationQueue, isQueueEnabled } from "./queue/queues";
import { createRateLimiter, rateLimitPresets } from "./middleware/rate-limiter";
import { validateBroadcastId } from "./middleware/broadcast-validator";
import { firebaseAuth } from "./middleware/firebase-auth";
import {
  createApiGate,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  readSessionOperatorId,
  resolveAllowlistedOperator,
} from "./middleware/authz";
import { ownerScope, readScopeOwnerId, createOwnerId } from "./middleware/capabilities";
import { createOwnershipGuard } from "./middleware/resource-ownership";
import { setVoteBroadcastFunction } from "./services/vote-processor";
import { sendAPNs } from "./services/ios-flow";
import { enqueueEvent } from "./events/outbox";
import { PLACEMENT_TOPICS } from "./events/types";
import {
  clearUserPresence,
  isRedisEnabled,
  isUserConnectedAcrossCluster,
  refreshUserPresence,
  setUserPresence,
  publishEvent,
  subscribeToEvents,
} from "./redis";

const JWT_SECRET = process.env.SESSION_SECRET || 'default-dev-secret';

function generateBroadcastId(name: string, date?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  const dateStr = date || new Date().toISOString().split('T')[0];
  return `${slug}-${dateStr}`;
}

const requireBearerAuth = (req: Request, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Bearer token required' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { clientAppId?: number; userId?: number };
    (req as any).authUser = decoded;
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Helper function to convert relative paths to absolute URLs
function toAbsoluteUrl(pathOrUrl: string | undefined, req: Request): string | undefined {
  if (!pathOrUrl) return undefined;

  // If already a full URL, return as is
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }

  // Detect protocol: check X-Forwarded-Proto header (set by reverse proxies) or use req.protocol
  // In production (Replit), X-Forwarded-Proto will be 'https'
  // In local dev, it will fall back to req.protocol which is 'http'
  // Handle comma-separated values from multiple proxies by taking the first one
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0].trim() || req.protocol || 'https';
  const host = req.get('host') || `localhost:${process.env.PORT || 5001}`;

  return `${protocol}://${host}${pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl}`;
}

// Helper function to calculate deterministic hash for user segmentation
// Returns a value 0-99 that is consistent for the same userId + campaignId
function calculateUserSegmentHash(userId: string, campaignId: number): number {
  const combined = `${userId}:${campaignId}`;
  const hash = createHash('sha256').update(combined).digest('hex');
  // Convert first 8 hex chars to a number and get modulo 100
  const hashValue = parseInt(hash.substring(0, 8), 16);
  return hashValue % 100;
}

// Helper function to check if user is eligible for segmented campaign
function isUserEligibleForCampaign(
  userId: string | undefined,
  userCountry: string | undefined,
  campaignId: number,
  isSegmented: string | undefined,
  targetCountries: string[] | null,
  targetPercentage: number | null
): boolean {
  // If campaign is not segmented, all users are eligible
  if (isSegmented !== 'true') {
    return true;
  }

  // If segmented, both userId and userCountry are required
  if (!userId || !userCountry) {
    return false;
  }

  // Check country eligibility
  if (targetCountries && targetCountries.length > 0) {
    if (!targetCountries.includes(userCountry.toUpperCase())) {
      return false;
    }
  }

  // Check percentage eligibility
  if (targetPercentage && targetPercentage < 100) {
    const userHash = calculateUserSegmentHash(userId, campaignId);
    if (userHash >= targetPercentage) {
      return false;
    }
  }

  return true;
}

// ============================================================
// User-targeted event delivery (TV → individual user mobile)
// ------------------------------------------------------------
// Generic envelope + routing layer shared by all "TV-originated, user-scoped"
// events. Today only `cart_intent` rides this path; future events
// (`poll_result`, `score_update`, etc.) plug in by:
//   1. Building a `VioEnvelope` with their `vio_event_type` + `vio_payload`
//   2. Calling `routeUserEvent(...)` with the envelope + a `wsEvent` wrapper
//   3. Persisting whatever per-event row they need with the returned
//      `deliveryMode + userConnected`
//
// Three layers:
//   - `buildCartIntentEnvelope`  → cart_intent-specific envelope shape
//   - `notifyUserEventViaPartner` → delivery-only (webhook or APNs)
//   - `routeUserEvent`            → triple-rama (local WS / Redis cluster /
//                                   partner fallback) + dual-delivery glue
//
// `sendAPNs` is still cart_intent-shaped; when a new event type lands we'll
// either generalize `sendAPNs(envelope)` or branch by `envelope.vio_event_type`.
// ============================================================

// Map userId → WebSocket for direct user-targeted notifications. Promoted to
// module level (was inside registerRoutes) so the user-event delivery helpers
// below can route without taking it as a parameter. Populated/cleaned by the
// WS upgrade handlers inside registerRoutes — same lifecycle as before.
const wsUserMap = new Map<string, WebSocket>();

interface VioEnvelope {
  vio_notification_version: number;
  vio_user_id: string;
  vio_event_type: string;
  vio_payload: Record<string, any>;
}

type UserEventDeliveryMode = "websocket" | "dual" | "webhook" | "apns" | "dropped";

/**
 * Builds the canonical cart_intent envelope. Single source of truth for the
 * shape consumed by both WS push (mobile) and partner webhook / APNs fallback.
 *
 * `activationId` and `sponsorId` are optional — only TV-originated cart_intents
 * carry them (so iOS can route to the right per-sponsor commerce key).
 */
function buildCartIntentEnvelope(args: {
  userId: string;
  campaignId: number | string;
  productId: string | number;
  productName: string;
  clientAppName: string;
  activationId?: number | null;
  sponsorId?: number | null;
}): VioEnvelope {
  const normalizedAppName = args.clientAppName.toLowerCase().replace(/\s+/g, "_");
  const source = `apptv_${normalizedAppName}`;
  const deeplink = `product/${args.productId}?campaignId=${args.campaignId}`;

  const payload: Record<string, any> = {
    product_id: String(args.productId),
    campaign_id: String(args.campaignId),
    product_name: args.productName,
    notification_title: args.productName,
    notification_body: `${args.productName} – klikk for å kjøpe.`,
    source,
    deeplink,
  };

  if (args.activationId != null) payload.activation_id = Number(args.activationId);
  if (args.sponsorId != null) payload.sponsor_id = Number(args.sponsorId);

  return {
    vio_notification_version: 1,
    vio_user_id: String(args.userId),
    vio_event_type: "cart_intent",
    vio_payload: payload,
  };
}

/**
 * Generic delivery helper for any user-targeted envelope.
 * - If clientApp.webhookUrl is set → POST envelope as-is to the partner.
 * - Otherwise, if iOS device tokens are registered → send APNs (currently
 *   only cart_intent payloads supported; other event types are skipped with
 *   a warning until per-type APNs builders exist).
 *
 * Replaces `notifyCartIntentPartnerFallback`. Construction of the envelope
 * is now the caller's responsibility — this function only delivers.
 */
async function notifyUserEventViaPartner(params: {
  clientApp: { webhookUrl?: string | null; name: string };
  envelope: VioEnvelope;
  context: "offline" | "dual";
  // Used only in the APNs fallback branch when there's no webhookUrl. The
  // current `sendAPNs` is cart_intent-shaped and needs the campaign id to
  // look up device tokens; passing it explicitly avoids re-parsing payload.
  campaignIdForDeviceLookup?: number;
}): Promise<void> {
  const { clientApp, envelope, context, campaignIdForDeviceLookup } = params;
  const userId = envelope.vio_user_id;
  const eventType = envelope.vio_event_type;
  const tag = `[UserEvent:${eventType}]`;

  const webhookUrl = clientApp?.webhookUrl?.trim();
  if (webhookUrl) {
    console.log(`${tag} Webhook body BEFORE POST to mock:`, JSON.stringify(envelope, null, 2));
    console.log(`${tag} userId=${userId}`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const webhookRes = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const label =
        context === "dual"
          ? "Dual delivery: partner webhook"
          : "Partner webhook called (offline user)";
      console.log(`${tag} ${label}: ${webhookUrl} → ${webhookRes.status}`);
    } catch (webhookErr: any) {
      if (webhookErr.name === "AbortError") {
        console.warn(`${tag} Webhook timeout (>10s)`);
      } else {
        console.error(`${tag} Webhook error:`, webhookErr);
      }
    }
    return;
  }

  // No webhook → try direct APNs. Today only cart_intent has an APNs builder;
  // when other event types ship, generalize sendAPNs(envelope) or branch here.
  if (eventType !== "cart_intent") {
    console.warn(
      `${tag} APNs fallback skipped — no APNs builder for vio_event_type='${eventType}'. Configure clientApp.webhookUrl.`,
    );
    return;
  }

  const campaignIdForDevices =
    campaignIdForDeviceLookup ?? Number(envelope.vio_payload.campaign_id);
  if (!Number.isFinite(campaignIdForDevices)) {
    console.warn(`${tag} APNs fallback skipped — invalid campaignId for device lookup`);
    return;
  }

  const devices = await storage.getDeviceTokens(campaignIdForDevices, String(userId));
  const iosDevices = devices.filter((d) => d.platform === "ios");
  if (iosDevices.length > 0) {
    const rawProductId = envelope.vio_payload.product_id;
    const pid =
      typeof rawProductId === "number" ? rawProductId : parseInt(String(rawProductId), 10);
    await sendAPNs(iosDevices, {
      campaignId: campaignIdForDevices,
      productId: Number.isFinite(pid) ? pid : 0,
      resolvedName: String(envelope.vio_payload.product_name ?? ""),
      userId: String(userId),
    });
    if (context === "dual") {
      console.log(`${tag} Dual delivery: invoked direct APNs (no webhook on client app)`);
    }
  } else {
    if (context === "dual") {
      console.log(`${tag} Dual delivery: skipped — no webhookUrl and no iOS device registered`);
    } else {
      console.log(`${tag} User offline/remote and no webhookUrl or iOS device registered`);
    }
  }
}

/**
 * Routes a user-targeted event through the canonical 3-branch decision tree:
 *   1. User WS connected to THIS node → send WS direct + (if dual) partner
 *   2. User WS connected on ANOTHER node → forward via Redis Pub/Sub + (if dual) partner
 *   3. User offline/unknown → partner webhook (or APNs fallback)
 *
 * Returns the delivery outcome so the caller can persist it in their per-event
 * row (cart_intents.delivery_mode, future analogous columns). Caller decides
 * what to persist, where, and what response to send.
 */
async function routeUserEvent(params: {
  userId: string;
  clientApp: { id: number; webhookUrl?: string | null; name: string };
  envelope: VioEnvelope;
  /** The WS message wrapping the envelope (typically `{ type, ...envelope, timestamp }`). */
  wsEvent: any;
  /** Override for `CART_INTENT_DUAL_DELIVERY` env var. Default: read from env. */
  dualDelivery?: boolean;
  /** Campaign id used by APNs fallback to look up device tokens (only matters
   *  when there's no `webhookUrl`). */
  campaignIdForDeviceLookup?: number;
}): Promise<{ deliveryMode: UserEventDeliveryMode; userConnected: boolean }> {
  const {
    userId,
    clientApp,
    envelope,
    wsEvent,
    campaignIdForDeviceLookup,
  } = params;
  const dualDelivery =
    params.dualDelivery ?? process.env.CART_INTENT_DUAL_DELIVERY !== "false";

  const eventType = envelope.vio_event_type;
  const tag = `[UserEvent:${eventType}]`;
  const normalizedUserId = String(userId).trim();
  const directWs = wsUserMap.get(normalizedUserId);
  const isConnectedLocal = Boolean(directWs && directWs.readyState === WebSocket.OPEN);

  // Cluster check with timeout to avoid hanging if Redis is down.
  let isConnectedCluster = false;
  if (isRedisEnabled()) {
    try {
      isConnectedCluster = await Promise.race([
        isUserConnectedAcrossCluster(normalizedUserId),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
    } catch (err) {
      console.warn(`${tag} isUserConnectedAcrossCluster error:`, err);
    }
  }
  const userConnected = isConnectedLocal || isConnectedCluster;

  let deliveryMode: UserEventDeliveryMode;

  if (isConnectedLocal && directWs) {
    directWs.send(JSON.stringify(wsEvent));
    console.log(`${tag} WS local → userId=${normalizedUserId}`);
    if (dualDelivery) {
      console.log(`${tag} Dual delivery: also invoking partner fallback`);
      await notifyUserEventViaPartner({
        clientApp, envelope, context: "dual", campaignIdForDeviceLookup,
      });
      deliveryMode = "dual";
    } else {
      deliveryMode = "websocket";
    }
  } else if (isConnectedCluster) {
    await publishEvent("ws:events:forward", wsEvent);
    console.log(`${tag} Redis Pub/Sub → cluster for userId=${normalizedUserId}`);
    if (dualDelivery) {
      console.log(`${tag} Dual delivery: also invoking partner fallback`);
      await notifyUserEventViaPartner({
        clientApp, envelope, context: "dual", campaignIdForDeviceLookup,
      });
      deliveryMode = "dual";
    } else {
      deliveryMode = "websocket";
    }
  } else {
    // Offline — partner webhook or direct APNs fallback.
    await notifyUserEventViaPartner({
      clientApp, envelope, context: "offline", campaignIdForDeviceLookup,
    });
    // Best-effort guess at which fallback actually ran (mirrors v2/tv legacy logic).
    const webhookConfigured = !!clientApp.webhookUrl?.trim();
    if (webhookConfigured) {
      deliveryMode = "webhook";
    } else if (campaignIdForDeviceLookup != null) {
      const devices = await storage.getDeviceTokens(
        campaignIdForDeviceLookup,
        normalizedUserId,
      );
      deliveryMode = devices.filter((d) => d.platform === "ios").length > 0
        ? "apns"
        : "dropped";
    } else {
      deliveryMode = "dropped";
    }
  }

  return { deliveryMode, userConnected };
}

/**
 * Commerce GraphQL credentials for a campaign — picks the first sponsor
 * (primary first, then secondaries) that has `commerceApiKey` configured.
 *
 * Per the storage convention, `campaign_sponsors` (junction) holds **only
 * secondaries**; the primary lives on `campaigns.primary_sponsor_id`. So we
 * delegate to `storage.getAllCampaignSponsors(...)` which composes
 * `[primary, ...secondaries]` in that order.
 *
 * Does not use `campaigns.reachu_api_key` (legacy column).
 */
async function resolveCommerceFromCampaignSponsors(
  campaignId: number | null,
): Promise<{ apiKey: string | null; channelId: string | null }> {
  if (campaignId == null) return { apiKey: null, channelId: null };
  const allSponsors = await storage.getAllCampaignSponsors(campaignId);
  for (const sp of allSponsors) {
    if (sp?.commerceApiKey) {
      return {
        apiKey: sp.commerceApiKey,
        channelId: sp.commerceChannelId || null,
      };
    }
  }
  return { apiKey: null, channelId: null };
}

// Export broadcastToCampaign function (will be set during registerRoutes).
//
// `module` is the subscription bucket the event belongs to ('placements',
// 'engagement', 'broadcast', 'cart_intent'). When provided, only sockets
// that have explicitly subscribed to that module receive the message.
// When omitted, the emit is a firehose to all sockets in the campaign
// room — kept that way for backward-compat with legacy callers (poll /
// contest / product / cart_intent direct emit paths) that pre-date the
// subscribe protocol.
//
// Sprint 2026-04-28 PM (Phase 2). See server/events/types.ts.
export let broadcastToCampaign: (campaignId: number, message: string, module?: string) => void = () => {
  console.warn('[WebSocket] broadcastToCampaign called before initialization');
};

// Tracks which broadcasts have had lineup_show sent (broadcastId → epoch ms)
// Module-level so both the manual endpoint and the scheduler can share state
export const lineupSentMap = new Map<string, number>();

export async function registerRoutes(app: Express, existingServer?: Server): Promise<Server> {
  const httpServer = existingServer ?? createServer(app);

  // Register analytics routes
  const { registerAnalyticsRoutes } = await import("./analytics");
  registerAnalyticsRoutes(app);

  // Create WebSocket server with noServer mode for custom path handling
  const wss = new WebSocketServer({ noServer: true });

  // Store connected clients organized by campaign ID
  const campaignClients = new Map<number, Set<WebSocket>>();

  // Store campaign ID for each WebSocket
  const clientCampaigns = new WeakMap<WebSocket, number>();

  // Store ping interval for each WebSocket
  const clientPingIntervals = new WeakMap<WebSocket, NodeJS.Timeout>();

  // Track if client is alive (responded to last ping)
  const clientAlive = new WeakMap<WebSocket, boolean>();

  // Track consecutive missed pings per client
  const clientMissedPings = new WeakMap<WebSocket, number>();

  // Track connection start time (ms) for uptime calculation
  const clientConnectTime = new WeakMap<WebSocket, number>();

  // Flag: true when the server intentionally terminated the socket (zombie)
  const clientTerminatedByServer = new WeakMap<WebSocket, boolean>();

  // (wsUserMap promoted to module-level — see top of file. Local references
  // here still resolve to that single instance.)
  // Map WebSocket → user connection binding for Redis-backed presence
  const clientUserBindings = new WeakMap<WebSocket, { userId: string; connectionId: string }>();

  // Map WebSocket → Set of subscribed module names ('placements',
  // 'engagement', etc.). Populated by the `subscribe` message handler;
  // GC'd automatically when the socket is collected.
  //
  // Filtering rule applied by `broadcastToCampaignLocal`:
  //   - Sockets that NEVER sent a `subscribe` message (legacy clients,
  //     dashboard, Apple TV) are absent from this map → treated as
  //     firehose ('*'), receive everything for backward compatibility.
  //   - Sockets that DID subscribe receive only events whose `module`
  //     field is in their set. Events emitted without a `module` arg
  //     bypass the filter (legacy emit paths stay unaffected).
  //
  // Sprint 2026-04-28 PM (Phase 2). See server/events/types.ts.
  const clientSubscriptions = new WeakMap<WebSocket, Set<string>>();

  // Function to broadcast to clients in a specific campaign (local node only).
  // When `module` is provided, filters per-socket by `clientSubscriptions`.
  const broadcastToCampaignLocal = (campaignId: number, message: string, module?: string) => {
    const clients = campaignClients.get(campaignId);
    if (!clients) return;
    clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (module) {
        const subs = clientSubscriptions.get(client);
        // Absent → legacy firehose. Present → must include this module.
        if (subs && !subs.has(module)) return;
      }
      console.log("Message Send!  Campaign:", campaignId, "Message:", message);
      client.send(message);
    });
  };

  // Subscribe to cross-node events via Redis Pub/Sub
  if (isRedisEnabled()) {
    subscribeToEvents("ws:events:forward", (messageStr) => {
      try {
        const event = JSON.parse(messageStr);
        if (event.type === 'cart_intent' && event.userId) {
          const targetWs = wsUserMap.get(String(event.userId).trim());
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify(event));
            console.log(`[WS] Forwarded cart_intent delivered locally to userId=${event.userId}`);
          }
        } else if (event.type === 'broadcast_campaign' && event.campaignId) {
          // Deliver forwarded campaign broadcast to local node clients.
          // `module` may be undefined for legacy events from older nodes —
          // broadcastToCampaignLocal treats undefined as firehose.
          broadcastToCampaignLocal(event.campaignId, event.message, event.module);
        }
      } catch (err) {
        console.error('[WS] Error processing cross-node event:', err);
      }
    });
  }

  // Handle WebSocket upgrade requests
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host}`);

      // Extract campaign ID from path like /ws/123
      const pathMatch = url.pathname.match(/^\/ws\/(\d+)$/);

      if (pathMatch) {
        // Campaign-specific WebSocket
        const campaignId = parseInt(pathMatch[1], 10);

        wss.handleUpgrade(request, socket, head, (ws) => {
          clientCampaigns.set(ws, campaignId);
          wss.emit('connection', ws, request, campaignId);
        });
      } else if (url.pathname === '/ws') {
        // Legacy WebSocket (no campaign ID) - use campaign ID 0 for backwards compatibility
        wss.handleUpgrade(request, socket, head, (ws) => {
          clientCampaigns.set(ws, 0);
          wss.emit('connection', ws, request, 0);
        });
      } else {
        socket.destroy();
      }
    } catch (error) {
      console.error('Error handling WebSocket upgrade:', error);
      socket.destroy();
    }
  });

  // WebSocket connection handling
  wss.on('connection', async (ws: WebSocket, request: any, campaignId: number) => {
    const connectionId = randomUUID();

    const bindUserToSocket = async (userIdRaw: string) => {
      const userId = String(userIdRaw).trim();
      if (!userId) return;

      const existingBinding = clientUserBindings.get(ws);
      if (existingBinding?.userId && wsUserMap.get(existingBinding.userId) === ws) {
        wsUserMap.delete(existingBinding.userId);
      }

      wsUserMap.set(userId, ws);
      clientUserBindings.set(ws, { userId, connectionId });

      if (isRedisEnabled()) {
        try {
          await setUserPresence(userId, connectionId);
        } catch (error) {
          console.error(`[WS] Failed to set Redis presence for userId=${userId}:`, error);
        }
      }
    };

    const refreshSocketPresence = async () => {
      const binding = clientUserBindings.get(ws);
      if (!binding || !isRedisEnabled()) return;
      try {
        await refreshUserPresence(binding.userId, binding.connectionId);
      } catch (error) {
        console.error(`[WS] Failed to refresh Redis presence for userId=${binding.userId}:`, error);
      }
    };

    // Add client to campaign room
    if (!campaignClients.has(campaignId)) {
      campaignClients.set(campaignId, new Set());
    }
    campaignClients.get(campaignId)!.add(ws);

    // Register userId → ws for direct notifications (cart-intent)
    const connUrl = new URL(request.url || '', `http://${request.headers.host}`);
    const connUserId = connUrl.searchParams.get('userId');
    if (connUserId) {
      await bindUserToSocket(connUserId);
      console.log(`[WS] userId=${connUserId} registered on campaign ${campaignId}`);
    }

    console.log(`Client connected to campaign ${campaignId}`);

    // Mark client as alive initially
    clientAlive.set(ws, true);
    clientMissedPings.set(ws, 0);
    clientConnectTime.set(ws, Date.now());
    clientTerminatedByServer.set(ws, false);

    // Heartbeat: ping every 20s, tolerate up to 3 consecutive missed pongs (60s window)
    // Uses app-level JSON ping/pong for iOS/Android SDK compatibility
    const PING_INTERVAL_MS = 20000;
    const MAX_MISSED_PINGS = 3;

    const pingInterval = setInterval(() => {
      if (clientAlive.get(ws) === false) {
        // Client didn't respond to last ping — increment miss counter
        const missed = (clientMissedPings.get(ws) ?? 0) + 1;
        clientMissedPings.set(ws, missed);

        if (missed >= MAX_MISSED_PINGS) {
          // Exceeded tolerance — terminate as zombie
          const uptime = Date.now() - (clientConnectTime.get(ws) ?? Date.now());
          const userId = clientUserBindings.get(ws)?.userId ?? null;
          console.log(JSON.stringify({
            event: 'zombie_terminated',
            campaignId,
            userId,
            missedPings: missed,
            uptimeMs: uptime,
          }));
          clientTerminatedByServer.set(ws, true);
          ws.terminate();
          return;
        }

        // Still within tolerance — warn and keep alive
        console.log(`[WS] Missed ping ${missed}/${MAX_MISSED_PINGS} for campaign ${campaignId} — still alive`);
      } else {
        // Pong received — reset miss counter
        clientMissedPings.set(ws, 0);
      }

      // Mark as potentially dead; will be reset to true when pong arrives
      clientAlive.set(ws, false);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
        void refreshSocketPresence();
      }
    }, PING_INTERVAL_MS);

    clientPingIntervals.set(ws, pingInterval);

    // Check campaign status and immediately notify client
    if (campaignId !== 0) {
      try {
        const campaign = await storage.getCampaign(campaignId);
        if (campaign) {
          if (hasCampaignEnded(campaign)) {
            // Campaign has ended (endDate in the past), notify client immediately
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'campaign_ended',
                campaignId: campaign.id,
                endDate: campaign.endDate
              }));
              console.log(`Sent campaign_ended notification to new client for campaign ${campaignId}`);
            }
          } else if (isCampaignUpcoming(campaign)) {
            // Campaign hasn't started yet (startDate in the future)
            // Don't send any event - components won't activate until campaign starts
            console.log(`Client connected to upcoming campaign ${campaignId} (starts: ${campaign.startDate})`);
          }
          // else: campaign is active or has no dates (always active) - no immediate event needed
        }
      } catch (error) {
        console.error('Error checking campaign status on connection:', error);
      }

      // Emit initial state: active polls and contests from the live broadcast
      try {
        const campaignBroadcasts = await storage.getCampaignBroadcasts(campaignId);
        const activeBroadcast = campaignBroadcasts.find(b => b.status === 'live');
        if (activeBroadcast) {
          const [polls, contests] = await Promise.all([
            storage.getBroadcastPolls(activeBroadcast.broadcastId),
            storage.getBroadcastContests(activeBroadcast.broadcastId)
          ]);
          const activePolls = polls.filter(p => p.isActive);
          const activeContests = contests.filter((c: any) => c.isActive);

          for (const poll of activePolls) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'poll',
                broadcastId: activeBroadcast.broadcastId,
                data: {
                  id: String(poll.id),
                  question: poll.question,
                  options: poll.options.map((o: any) => ({ text: o.text })),
                  duration: poll.duration ?? 60,
                },
                timestamp: Date.now()
              }));
            }
          }

          for (const contest of activeContests) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'contest',
                broadcastId: activeBroadcast.broadcastId,
                id: String(contest.id),
                title: contest.title,
                description: contest.description || '',
                prize: contest.prize || '',
                contestType: contest.contestType,
                imageUrl: contest.imageUrl ? normalizeUrls(contest.imageUrl) : null,
                isActive: true,
                timestamp: Date.now()
              }));
            }
          }

          if (activePolls.length > 0 || activeContests.length > 0) {
            console.log(`[WS] Sent initial state to new client: ${activePolls.length} polls, ${activeContests.length} contests for broadcast ${activeBroadcast.broadcastId}`);
          }
        }
      } catch (error) {
        console.error('Error emitting initial broadcast state on connection:', error);
      }
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pong') {
          // Client responded to app-level ping, mark as alive
          clientAlive.set(ws, true);
          void refreshSocketPresence();
        } else if (msg.type === 'identify' && msg.userId) {
          void bindUserToSocket(msg.userId);
          console.log(`[WS] identify recibido: userId=${String(msg.userId)} en campaign ${campaignId}`);
        } else if (msg.type === 'subscribe' && Array.isArray(msg.modules)) {
          // Module-aware subscribe: SDK declares which event buckets it
          // wants to receive. Sockets that never send this remain on the
          // legacy firehose path. Whitelist incoming module names against
          // the canonical set so we don't store garbage.
          const ALLOWED_MODULES = new Set(['placements', 'engagement', 'broadcast', 'cart_intent']);
          const modules = new Set<string>(
            msg.modules.filter((m: unknown): m is string => typeof m === 'string' && ALLOWED_MODULES.has(m))
          );
          clientSubscriptions.set(ws, modules);
          console.log(`[WS] subscribe recibido: modules=[${Array.from(modules).join(',')}] en campaign ${campaignId}`);
        }
      } catch { /* ignorar mensajes no-JSON */ }
    });

    ws.on('close', (code: number) => {
      // Structured disconnect log — distinguish zombie vs voluntary close
      const wasZombie = clientTerminatedByServer.get(ws) === true;
      const uptimeMs = Date.now() - (clientConnectTime.get(ws) ?? Date.now());
      const userId = clientUserBindings.get(ws)?.userId ?? null;

      if (!wasZombie) {
        // code 1000 = normal closure, 1001 = going away (client navigated/backgrounded)
        const closeType = (code === 1000 || code === 1001) ? 'clean' : 'unexpected';
        console.log(JSON.stringify({
          event: 'client_disconnected',
          campaignId,
          userId,
          code,
          closeType,
          uptimeMs,
        }));
      }
      // zombie_terminated already logged at terminate() time — no duplicate log here

      // Clear ping interval
      const interval = clientPingIntervals.get(ws);
      if (interval) {
        clearInterval(interval);
        clientPingIntervals.delete(ws);
      }

      const clients = campaignClients.get(campaignId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          campaignClients.delete(campaignId);
        }
      }

      // Clean up userId map
      const userBinding = clientUserBindings.get(ws);
      if (userBinding?.userId && wsUserMap.get(userBinding.userId) === ws) {
        wsUserMap.delete(userBinding.userId);
        console.log(`[WS] userId=${userBinding.userId} removed from map (disconnected)`);
      }
      if (userBinding && isRedisEnabled()) {
        void clearUserPresence(userBinding.userId, userBinding.connectionId).catch((error) => {
          console.error(`[WS] Failed to clear Redis presence for userId=${userBinding.userId}:`, error);
        });
      }
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for campaign ${campaignId}:`, error);

      // Clear ping interval
      const interval = clientPingIntervals.get(ws);
      if (interval) {
        clearInterval(interval);
        clientPingIntervals.delete(ws);
      }

      const clients = campaignClients.get(campaignId);
      if (clients) {
        clients.delete(ws);
      }

      const userBinding = clientUserBindings.get(ws);
      if (userBinding && isRedisEnabled()) {
        void clearUserPresence(userBinding.userId, userBinding.connectionId).catch((clearError) => {
          console.error(`[WS] Failed to clear Redis presence on error for userId=${userBinding.userId}:`, clearError);
        });
      }
    });
  });

  // Function to broadcast to clients in a specific campaign.
  // `module` is forwarded through the Redis envelope so cross-node
  // delivery preserves the per-socket subscription filter.
  const broadcastToCampaignImpl = (campaignId: number, message: string, module?: string) => {
    if (isRedisEnabled()) {
      // Forward to all nodes via Redis (including this one)
      publishEvent("ws:events:forward", {
        type: 'broadcast_campaign',
        campaignId,
        message,
        module,
      });
    } else {
      // Redis disabled: broadcast locally only
      broadcastToCampaignLocal(campaignId, message, module);
    }
  };

  broadcastToCampaign = broadcastToCampaignImpl;
  setVoteBroadcastFunction(broadcastToCampaignImpl);

  // Legacy broadcast function (broadcasts to all campaigns)
  function broadcast(message: string) {
    campaignClients.forEach((clients) => {
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });
  }

  // Check for ended campaigns and broadcast campaign_ended events
  async function checkAndNotifyEndedCampaigns() {
    try {
      const campaigns = await storage.getAllCampaigns();
      const now = new Date();

      for (const campaign of campaigns) {
        if (campaign.endDate) {
          const endDate = new Date(campaign.endDate);
          // Check if campaign just ended (within last minute)
          const timeDiff = now.getTime() - endDate.getTime();
          if (timeDiff >= 0 && timeDiff < 60000) {
            // Campaign just ended, broadcast to all connected clients
            broadcastToCampaignImpl(campaign.id, JSON.stringify({
              type: 'campaign_ended',
              campaignId: campaign.id,
              endDate: campaign.endDate
            }));
            console.log(`Campaign ${campaign.id} (${campaign.name}) has ended`);
          }
        }
      }
    } catch (error) {
      console.error('Error checking ended campaigns:', error);
    }
  }

  // Check for started campaigns and broadcast campaign_started events
  async function checkAndNotifyStartedCampaigns() {
    try {
      const campaigns = await storage.getAllCampaigns();
      const now = new Date();

      for (const campaign of campaigns) {
        if (campaign.startDate) {
          const startDate = new Date(campaign.startDate);
          // Check if campaign just started (within last minute)
          const timeDiff = now.getTime() - startDate.getTime();
          if (timeDiff >= 0 && timeDiff < 60000) {
            // Campaign just started, broadcast to all connected clients
            const event: any = {
              type: 'campaign_started',
              campaignId: campaign.id,
              startDate: campaign.startDate,
              endDate: campaign.endDate
            };
            // Include matchId if campaign is associated with a match
            if (campaign.matchId) {
              event.matchId = campaign.matchId;
            }
            broadcastToCampaignImpl(campaign.id, JSON.stringify(event));
            console.log(`Campaign ${campaign.id} (${campaign.name}) has started`);
          }
        }
      }
    } catch (error) {
      console.error('Error checking started campaigns:', error);
    }
  }

  // Check every 30 seconds for campaign lifecycle events
  setInterval(checkAndNotifyEndedCampaigns, 30000);
  setInterval(checkAndNotifyStartedCampaigns, 30000);

  const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
  async function fetchGraphQL(
    query: string,
    commerceApiKey: string,
    retries = 3,
    variables?: Record<string, unknown>,
  ): Promise<any> {
    console.log('[GraphQL] Fetching data...');
    try {
      const res = await fetch(process.env.COMMERCE_GRAPHQL_URL || 'http://graph-ql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': commerceApiKey,
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });

      if (!res.ok) {
        console.error(`[GraphQL] HTTP error ${res.status}:`, await res.text());
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      if (data.errors) {
        throw new Error(`GraphQL error`);
      }

      return data;

    } catch (err: any) {
      console.log(`[GraphQL] Error fetching data (retries left: ${retries - 1}):`, err.message);
      const code = err?.cause?.code || err?.code;
      const isRetryable =
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        err.message?.includes('fetch failed');

      if (retries > 0 && isRetryable) {
        await delay(200 * (4 - retries));
        return fetchGraphQL(query, commerceApiKey, retries - 1);
      }

      console.error('[GraphQL error]', {
        message: err.message,
        code,
      });
    }
  }

  // ── Operator auth (ADR-0007) ──────────────────────────────────────────
  // Session endpoints first, then the role gate via app.use('/api', …):
  // every /api route registered after this point requires an operator
  // session unless listed in PUBLIC_API (authz.ts).

  const operatorProfile = (u: typeof users.$inferSelect) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    sponsorId: u.sponsorId,
    parentAdminId: u.parentAdminId,
    linked: Boolean(u.firebaseUid),
  });

  // Exchange a verified Firebase ID token (shared Commerce project) for a
  // first-party session cookie. Strict allowlist — see resolveAllowlistedOperator.
  app.post('/api/auth/session', firebaseAuth, async (req, res) => {
    try {
      const operator = await resolveAllowlistedOperator(storage, req.firebaseIdentity!);
      if (!operator) {
        return res.status(403).json({ message: 'Account is not provisioned for this dashboard' });
      }
      setSessionCookie(res, createSessionToken(operator.id));
      res.json(operatorProfile(operator));
    } catch (error) {
      console.error('Error creating operator session:', error);
      res.status(500).json({ message: 'Error creating session' });
    }
  });

  app.delete('/api/auth/session', (_req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      const operatorId = readSessionOperatorId(req);
      if (operatorId) {
        const operator = await storage.getUser(operatorId);
        if (operator) return res.json(operatorProfile(operator));
      }
      res.status(401).json({ message: 'No active session' });
    } catch (error) {
      console.error('Error reading session:', error);
      res.status(500).json({ message: 'Error reading session' });
    }
  });

  app.use('/api', createApiGate({ loadOperator: (id) => storage.getUser(id) }));
  // Per-resource tenant ownership (ADR-0008): after the capability gate, block
  // cross-tenant access to a specific resource by id. super_admin bypasses.
  app.use('/api', createOwnershipGuard(storage));

  // Allowlist management. The gate maps /api/auth/users* to super_admin.
  app.get('/api/auth/users', async (_req, res) => {
    try {
      const all = await storage.getAllUsers();
      res.json(all.map(operatorProfile));
    } catch (error) {
      console.error('Error listing operators:', error);
      res.status(500).json({ message: 'Error listing operators' });
    }
  });

  app.post('/api/auth/users', async (req, res) => {
    try {
      const { email, role, name, sponsorId, parentAdminId } = req.body ?? {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ message: 'email is required' });
      }
      if (!userRoleEnum.enumValues.includes(role)) {
        return res.status(400).json({ message: `role must be one of: ${userRoleEnum.enumValues.join(', ')}` });
      }
      if (role === 'viewer' && sponsorId != null && !(await storage.getSponsor(Number(sponsorId)))) {
        return res.status(400).json({ message: 'sponsorId does not exist' });
      }
      // operator/viewer belong to an admin's tenant (ADR-0007).
      if ((role === 'operator' || role === 'viewer')) {
        if (parentAdminId == null) {
          return res.status(400).json({ message: 'parentAdminId is required for operator/viewer (the admin tenant they belong to)' });
        }
        const admin = await storage.getUser(Number(parentAdminId));
        if (!admin || (admin.role !== 'admin' && admin.role !== 'super_admin')) {
          return res.status(400).json({ message: 'parentAdminId must reference an admin' });
        }
      }
      const existing = await storage.getUserByEmailInsensitive(email);
      if (existing) {
        return res.status(409).json({ message: 'A user with this email already exists' });
      }
      const created = await storage.createUser({
        email: email.toLowerCase(),
        name: name ?? null,
        role,
        sponsorId: sponsorId ?? null,
        parentAdminId: (role === 'operator' || role === 'viewer') ? Number(parentAdminId) : null,
      });
      res.status(201).json(operatorProfile(created));
    } catch (error) {
      console.error('Error creating operator:', error);
      res.status(500).json({ message: 'Error creating operator' });
    }
  });

  app.patch('/api/auth/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { role, name, sponsorId } = req.body ?? {};
      if (role !== undefined && !userRoleEnum.enumValues.includes(role)) {
        return res.status(400).json({ message: `role must be one of: ${userRoleEnum.enumValues.join(', ')}` });
      }
      if (id === req.operator!.id && role !== undefined && role !== 'super_admin') {
        return res.status(400).json({ message: 'You cannot demote your own account' });
      }
      const updated = await storage.updateUser(id, {
        ...(role !== undefined ? { role } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(sponsorId !== undefined ? { sponsorId } : {}),
      });
      if (!updated) return res.status(404).json({ message: 'User not found' });
      res.json(operatorProfile(updated));
    } catch (error) {
      console.error('Error updating operator:', error);
      res.status(500).json({ message: 'Error updating operator' });
    }
  });

  app.delete('/api/auth/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (id === req.operator!.id) {
        return res.status(400).json({ message: 'You cannot delete your own account' });
      }
      await storage.deleteUser(id);
      res.status(204).end();
    } catch (error) {
      console.error('Error deleting operator:', error);
      res.status(500).json({ message: 'Error deleting operator' });
    }
  });

  // HTTP API endpoints
  // Post update payment methods by apykey
  app.post('/api/campaign/payments/apikey/:apiKey', async (req, res) => {
    const response = {
      message: "",
      status: "success",
      code: 200
    }
    try {
      const _apiKey = req.params.apiKey;
      const { paymentMethods } = req.body;

      const sponsors = await storage.getSponsorsByApiKey(_apiKey);
      if (!sponsors || sponsors.length === 0) {
        throw new Error('Sponsors not found for provided API key');
      }
      if(paymentMethods && !Array.isArray(paymentMethods)) {
        throw new Error('paymentMethods should be an array');
      }

      const processSponsors = async (sponsor: Sponsor) => {
        try {
          await storage.updateSponsorPaymentMethods(sponsor.id, paymentMethods);          
        } catch (error) {
          console.error(`Error updating payment methods for sponsor ${sponsor.id}:`, error);
        }
      }

      await Promise.allSettled(sponsors.map(processSponsors));
      
      response.message = `Payment methods updated successfully: ${JSON.stringify(paymentMethods)} to ${sponsors.length} sponsor(s) with API key ${_apiKey}`;

    } catch (error) {
      console.error('Error updating payment methods:', error);
      response.message = "Error updating payment methods";
      response.status = "error";
      response.code = 500;
    }
    res.status(response.code).json(response);
  });

  // Get recent events
  app.get('/api/events', async (req, res) => {
    try {
      const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string) : undefined;

      if (campaignId) {
        // Get events for specific campaign from database
        const dbEvents = await storage.getCampaignEvents(campaignId);
        // Convert DB events to WebSocket events format
        const events = dbEvents.map(dbEvent => ({
          type: dbEvent.type,
          data: dbEvent.data,
          campaignLogo: dbEvent.campaignLogo || undefined,
          timestamp: new Date(dbEvent.timestamp).getTime()
        }));
        res.json(events);
      } else {
        // Get all recent events from memory (legacy)
        const events = await storage.getRecentEvents();
        res.json(events);
      }
    } catch (error) {
      console.error('Error fetching events:', error);
      res.status(500).json({ message: 'Error fetching events' });
    }
  });

  // Get events for a specific campaign (RESTful route)
  app.get('/api/events/:campaignId', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.campaignId);

      if (isNaN(campaignId)) {
        return res.status(400).json({ message: 'Invalid campaign ID' });
      }

      // Get events for specific campaign from database
      const dbEvents = await storage.getCampaignEvents(campaignId);

      // Convert DB events to WebSocket events format
      const events = dbEvents.map(dbEvent => ({
        id: dbEvent.id,
        type: dbEvent.type,
        data: dbEvent.data,
        campaignLogo: dbEvent.campaignLogo || undefined,
        timestamp: new Date(dbEvent.timestamp).getTime()
      }));

      // Optional deduplication - show only most recent event per unique name
      const includeAll = req.query.includeAll === 'true';
      if (!includeAll) {
        // Group events by type and name, keep only most recent
        const eventMap = new Map<string, typeof events[0]>();

        for (const event of events) {
          // Create unique key based on type and event name/question
          let eventName = '';
          if (event.type === 'product' && typeof event.data === 'object' && event.data !== null && 'name' in event.data) {
            eventName = String(event.data.name || '');
          } else if (event.type === 'poll' && typeof event.data === 'object' && event.data !== null && 'question' in event.data) {
            eventName = String(event.data.question || '');
          } else if (event.type === 'contest' && typeof event.data === 'object' && event.data !== null && 'name' in event.data) {
            eventName = String(event.data.name || '');
          }

          const key = `${event.type}:${eventName}`;
          const existing = eventMap.get(key);

          // Keep the one with the latest timestamp
          if (!existing || event.timestamp > existing.timestamp) {
            eventMap.set(key, event);
          }
        }

        // Convert map back to array and sort by timestamp desc
        const dedupedEvents = Array.from(eventMap.values())
          .sort((a, b) => b.timestamp - a.timestamp);

        res.json(dedupedEvents);
      } else {
        res.json(events);
      }
    } catch (error) {
      console.error('Error fetching campaign events:', error);
      res.status(500).json({ message: 'Error fetching events' });
    }
  });

  // Get connection status
  app.get('/api/status', (req, res) => {
    res.json({
      server: 'running',
      wsPort: 'same as http',
      httpPort: process.env.PORT || 5000
    });
  });

  // Trigger product event
  app.post('/api/events/product', async (req, res) => {
    try {
      const campaignId = req.body.campaignId;

      // Validate campaignId if provided
      if (campaignId) {
        const campaign = await storage.getCampaign(campaignId);
        if (!campaign) {
          return res.status(404).json({ message: 'Campaign not found' });
        }
      }

      const productEvent: WebSocketEvent = {
        type: 'product',
        data: {
          id: `prod_${randomUUID()}`,
          productId: req.body.productId,
          name: req.body.name,
          description: req.body.description,
          price: String(req.body.price),
          currency: req.body.currency || 'USD',
          imageUrl: toAbsoluteUrl(req.body.imageUrl, req)
        },
        campaignLogo: toAbsoluteUrl(req.body.campaignLogo, req),
        timestamp: Date.now()
      };

      // Validate the event
      webSocketEventSchema.parse(productEvent);

      // Store the event in memory (for backwards compatibility)
      await storage.addEvent(productEvent);

      // Store in database if campaignId provided
      if (campaignId) {
        await storage.addCampaignEvent({
          campaignId,
          type: 'product',
          data: productEvent.data,
          campaignLogo: productEvent.campaignLogo || null
        });

        // Broadcast to specific campaign
        broadcastToCampaignImpl(campaignId, JSON.stringify(productEvent));
      } else {
        // Legacy: Broadcast to all connected clients
        broadcast(JSON.stringify(productEvent));
      }

      res.json({ success: true, event: productEvent });
    } catch (error) {
      console.error('Error sending product event:', error);
      res.status(400).json({
        message: 'Error sending product event',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Trigger poll event
  app.post('/api/events/poll', async (req, res) => {
    try {
      const campaignId = req.body.campaignId;

      // Validate campaignId if provided
      if (campaignId) {
        const campaign = await storage.getCampaign(campaignId);
        if (!campaign) {
          return res.status(404).json({ message: 'Campaign not found' });
        }
      }

      // Process options: convert comma-separated string to array or process objects
      let options;
      if (typeof req.body.options === 'string') {
        // Legacy format: comma-separated string
        options = req.body.options.split(',').map((opt: string) => ({
          text: opt.trim(),
          imageUrl: undefined
        })).filter((opt: any) => opt.text);
      } else if (Array.isArray(req.body.options)) {
        // New format: array of objects with optional imageUrl
        options = req.body.options.map((opt: any) => ({
          text: opt.text,
          imageUrl: toAbsoluteUrl(opt.imageUrl, req)
        }));
      } else {
        options = [];
      }

      // Process duration: convert to number
      const duration = typeof req.body.duration === 'string'
        ? parseInt(req.body.duration, 10)
        : req.body.duration;

      const pollEvent: WebSocketEvent = {
        type: 'poll',
        broadcastId: req.body.broadcastId || undefined,
        data: {
          id: `poll_${randomUUID()}`,
          question: req.body.question,
          options,
          duration,
          imageUrl: toAbsoluteUrl(req.body.imageUrl, req)
        },
        campaignLogo: toAbsoluteUrl(req.body.campaignLogo, req),
        timestamp: Date.now()
      };

      // Validate the event
      webSocketEventSchema.parse(pollEvent);

      // Store the event in memory
      await storage.addEvent(pollEvent);

      // Store in database if campaignId provided
      if (campaignId) {
        await storage.addCampaignEvent({
          campaignId,
          type: 'poll',
          data: pollEvent.data,
          campaignLogo: pollEvent.campaignLogo || null
        });

        // Broadcast to specific campaign
        broadcastToCampaignImpl(campaignId, JSON.stringify(pollEvent));
      } else {
        // Legacy: Broadcast to all connected clients
        broadcast(JSON.stringify(pollEvent));
      }

      res.json({ success: true, event: pollEvent });
    } catch (error) {
      console.error('Error sending poll event:', error);
      res.status(400).json({ message: 'Error sending poll event' });
    }
  });

  // Trigger contest event
  app.post('/api/events/contest', async (req, res) => {
    try {
      const campaignId = req.body.campaignId;

      // Validate campaignId if provided
      if (campaignId) {
        const campaign = await storage.getCampaign(campaignId);
        if (!campaign) {
          return res.status(404).json({ message: 'Campaign not found' });
        }
      }

      const contestEvent: WebSocketEvent = {
        type: 'contest',
        broadcastId: req.body.broadcastId || undefined,
        data: {
          id: `contest_${randomUUID()}`,
          name: req.body.name,
          prize: req.body.prize,
          deadline: req.body.deadline,
          maxParticipants: req.body.maxParticipants
        },
        campaignLogo: toAbsoluteUrl(req.body.campaignLogo, req),
        timestamp: Date.now()
      };

      // Validate the event
      webSocketEventSchema.parse(contestEvent);

      // Store the event in memory
      await storage.addEvent(contestEvent);

      // Store in database if campaignId provided
      if (campaignId) {
        await storage.addCampaignEvent({
          campaignId,
          type: 'contest',
          data: contestEvent.data,
          campaignLogo: contestEvent.campaignLogo || null
        });

        // Broadcast to specific campaign
        broadcastToCampaignImpl(campaignId, JSON.stringify(contestEvent));
      } else {
        // Legacy: Broadcast to all connected clients
        broadcast(JSON.stringify(contestEvent));
      }

      res.json({ success: true, event: contestEvent });
    } catch (error) {
      console.error('Error sending contest event:', error);
      res.status(400).json({ message: 'Error sending contest event' });
    }
  });

  // Generic event endpoint for campaign (RESTful route)
  app.post('/api/events/:campaignId', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.campaignId);

      if (isNaN(campaignId)) {
        return res.status(400).json({ message: 'Invalid campaign ID' });
      }

      // Validate campaign exists
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }

      const { type, data } = req.body;

      if (!type || !data) {
        return res.status(400).json({ message: 'Event type and data are required' });
      }

      // Create event based on type
      let event: WebSocketEvent;

      if (type === 'product') {
        event = {
          type: 'product',
          data: {
            id: `prod_${randomUUID()}`,
            ...data
          },
          campaignLogo: campaign.logo || undefined,
          timestamp: Date.now()
        };
      } else if (type === 'poll') {
        event = {
          type: 'poll',
          broadcastId: req.body.broadcastId || undefined,
          data: {
            id: `poll_${randomUUID()}`,
            ...data
          },
          campaignLogo: campaign.logo || undefined,
          timestamp: Date.now()
        };
      } else if (type === 'contest') {
        event = {
          type: 'contest',
          broadcastId: req.body.broadcastId || undefined,
          data: {
            id: `contest_${randomUUID()}`,
            ...data
          },
          campaignLogo: campaign.logo || undefined,
          timestamp: Date.now()
        };
      } else {
        return res.status(400).json({ message: 'Invalid event type' });
      }

      // Validate the event
      webSocketEventSchema.parse(event);

      // Store in memory for legacy compatibility
      await storage.addEvent(event);

      // Store the event in database
      await storage.addCampaignEvent({
        campaignId,
        type: event.type,
        data: event.data,
        campaignLogo: event.campaignLogo || null
      });

      // Broadcast to specific campaign
      broadcastToCampaignImpl(campaignId, JSON.stringify(event));

      res.json({ success: true, event });
    } catch (error) {
      console.error('Error sending campaign event:', error);
      res.status(400).json({ message: 'Error sending event' });
    }
  });

  // Object Storage endpoints - based on blueprint:javascript_object_storage

  // Serve uploaded objects (public access for campaign logos)
  app.get("/objects/:objectPath(*)", async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(
        req.path,
      );
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error checking object access:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // Get upload URL for object (campaign logo)
  app.post("/api/objects/upload", async (req, res) => {
    if (!req.body.type) {
      return res.status(400).json({ error: "type is required" });
    }
    const objectStorageService = new ObjectStorageService();
    const uploadURL = await objectStorageService.getObjectEntityUploadURL(req.body.type);
    res.json({ uploadURL });
  });

  // Normalize uploaded campaign logo URL
  app.put("/api/campaign-logo", async (req, res) => {
    if (!req.body.logoURL) {
      return res.status(400).json({ error: "logoURL is required" });
    }

    try {
      const objectStorageService = new ObjectStorageService();
      const objectPath = objectStorageService.normalizeObjectEntityPath(
        req.body.logoURL,
      );

      res.status(200).json({
        objectPath: objectPath,
      });
    } catch (error) {
      console.error("Error setting campaign logo:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // User CRUD endpoints

  // Get all users
  app.get('/api/users', async (req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      res.json(allUsers);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ message: 'Error fetching users' });
    }
  });

  // Get user by ID
  app.get('/api/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json(user);
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ message: 'Error fetching user' });
    }
  });

  // Get user by Reachu ID
  app.get('/api/users/reachu/:reachuUserId', async (req, res) => {
    try {
      const user = await storage.getUserByReachuId(req.params.reachuUserId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json(user);
    } catch (error) {
      console.error('Error fetching user by Reachu ID:', error);
      res.status(500).json({ message: 'Error fetching user' });
    }
  });

  // POST /api/users/ensure (simulated session) removed in ADR-0007 F2 —
  // operator sessions come from POST /api/auth/session now.

  app.post('/api/auth/token', async (req, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey) {
        return res.status(400).json({ message: 'apiKey is required' });
      }
      const clientApp = await storage.getClientAppByApiKey(apiKey);
      if (!clientApp) {
        return res.status(404).json({ message: 'Client app not found' });
      }
      const token = jwt.sign(
        { clientAppId: clientApp.id },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ token, clientAppId: clientApp.id, expiresIn: '7d' });
    } catch (error) {
      console.error('Error generating token:', error);
      res.status(500).json({ message: 'Error generating token' });
    }
  });

  // Create user
  app.post('/api/users', async (req, res) => {
    try {
      const user = await storage.createUser(req.body);
      res.status(201).json(user);
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(400).json({
        message: 'Error creating user',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Update user
  app.patch('/api/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await storage.updateUser(id, req.body);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json(user);
    } catch (error) {
      console.error('Error updating user:', error);
      res.status(500).json({ message: 'Error updating user' });
    }
  });

  // Client Apps CRUD endpoints

  // Get all client apps for a user
  app.get('/api/client-apps', async (req, res) => {
    try {
      // Scoped to the authenticated operator's tenant (ADR-0007); super_admin
      // sees all. The legacy ?userId= query param is ignored.
      const owner = readScopeOwnerId(req.operator);
      const apps = owner === null
        ? await storage.getAllClientApps()
        : await storage.getUserClientApps(owner);
      res.json(apps);
    } catch (error) {
      console.error('Error fetching client apps:', error);
      res.status(500).json({ message: 'Error fetching client apps' });
    }
  });

  app.get('/api/client-apps/with-stats', async (req, res) => {
    try {
      const owner = readScopeOwnerId(req.operator);

      const apps = owner === null ? await storage.getAllClientApps() : await storage.getUserClientApps(owner);
      const allChannels = owner === null ? await storage.getAllChannels() : await storage.getUserChannels(owner);
      const allCampaigns = owner === null ? await storage.getAllCampaigns() : await storage.getUserCampaigns(owner);
      const allBroadcasts = await storage.getAllBroadcasts();

      const result = await Promise.all(apps.map(async (app) => {
        const appChannels = allChannels.filter(ch => ch.clientAppId === app.id);
        const appChannelIds = new Set(appChannels.map(ch => ch.id));

        const appCampaigns = allCampaigns.filter(c =>
          c.clientAppId === app.id || (c.channelId && appChannelIds.has(c.channelId))
        );
        const appCampaignIds = new Set(appCampaigns.map(c => c.id));

        const appBroadcasts = allBroadcasts.filter(b =>
          (b.campaignId && appCampaignIds.has(b.campaignId)) ||
          (b.channelId && appChannelIds.has(b.channelId))
        );

        const activeBroadcasts = appBroadcasts.filter(b => b.status === 'live').length;
        const totalViewers = appBroadcasts.reduce((sum, b) => sum + (b.viewerCount || 0), 0);

        // Calculate engagement
        let totalEngagement = 0;
        if (appBroadcasts.length > 0) {
          const broadcastIds = appBroadcasts.map(b => b.broadcastId);
          const engagementCounts = await storage.getBroadcastEngagementCounts(broadcastIds);
          Array.from(engagementCounts.values()).forEach((count: any) => {
            totalEngagement += count.pollCount || 0; // The schema says pollCount/activePollCount/contestCount
            totalEngagement += count.contestCount || 0;
          });
        }

        const engagementPercent = totalViewers > 0
          ? Number(((totalEngagement / totalViewers) * 100).toFixed(1))
          : 0;

        return {
          ...app,
          stats: {
            campaignCount: appCampaigns.length,
            activeBroadcasts,
            totalViewers,
            channelCount: appChannels.length,
            engagementPercent,
          },
        };
      }));

      res.json(result);
    } catch (error) {
      console.error('Error fetching client apps with stats:', error);
      res.status(500).json({ message: 'Error fetching client apps with stats' });
    }
  });

  // Get single client app — ownership enforced by session (ADR-0007).
  app.get('/api/client-apps/:id', async (req, res) => {
    try {
      const app = await storage.getClientApp(parseInt(req.params.id));
      if (!app) {
        return res.status(404).json({ message: 'Client app not found' });
      }

      // super_admin (owner === null) sees any app; everyone else only their tenant's.
      const owner = readScopeOwnerId(req.operator);
      if (owner !== null && app.userId !== owner) {
        return res.status(403).json({ message: 'Access denied' });
      }

      res.json(app);
    } catch (error) {
      console.error('Error fetching client app:', error);
      res.status(500).json({ message: 'Error fetching client app' });
    }
  });

  // Sponsor CRUD endpoints

  app.get('/api/sponsors', async (req, res) => {
    try {
      const owner = readScopeOwnerId(req.operator);
      const result = owner === null
        ? await storage.getAllSponsors()
        : await storage.getUserSponsors(owner);
      res.json(result);
    } catch (error) {
      console.error('Error fetching sponsors:', error);
      res.status(500).json({ message: 'Error fetching sponsors' });
    }
  });

  app.get('/api/sponsors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const sponsor = await storage.getSponsor(id);
      if (!sponsor) return res.status(404).json({ message: 'Sponsor not found' });
      res.json(sponsor);
    } catch (error) {
      console.error('Error fetching sponsor:', error);
      res.status(500).json({ message: 'Error fetching sponsor' });
    }
  });

  app.post('/api/sponsors', async (req, res) => {
    try {
      const { name, description, logoUrl, avatarUrl, primaryColor, secondaryColor } = req.body;
      if (!name) {
        return res.status(400).json({ message: 'name is required' });
      }
      // Owner is the creator's tenant (super_admin may target via body.userId).
      const userId = createOwnerId(req.operator, req.body.userId);
      const sponsor = await storage.createSponsor({
        userId,
        name,
        description: description || null,
        logoUrl: logoUrl || null,
        avatarUrl: avatarUrl || null,
        primaryColor: primaryColor || null,
        secondaryColor: secondaryColor || null,
      });
      res.status(201).json(sponsor);
    } catch (error) {
      console.error('Error creating sponsor:', error);
      res.status(400).json({ message: 'Error creating sponsor' });
    }
  });

  app.patch('/api/sponsors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { userId, ...updateData } = req.body;
      if (!userId) return res.status(400).json({ message: 'userId is required' });

      const existing = await storage.getSponsor(id);
      if (!existing) return res.status(404).json({ message: 'Sponsor not found' });
      if (existing.userId !== userId) return res.status(403).json({ message: 'Access denied' });

      const sponsor = await storage.updateSponsor(id, updateData);
      res.json(sponsor);
    } catch (error) {
      console.error('Error updating sponsor:', error);
      res.status(500).json({ message: 'Error updating sponsor' });
    }
  });

  app.delete('/api/sponsors/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const userId = parseInt(req.query.userId as string);
      if (!userId) return res.status(400).json({ message: 'userId is required' });

      const existing = await storage.getSponsor(id);
      if (!existing) return res.status(404).json({ message: 'Sponsor not found' });
      if (existing.userId !== userId) return res.status(403).json({ message: 'Access denied' });

      await storage.deleteSponsor(id);
      res.json({ message: 'Sponsor deleted' });
    } catch (error) {
      console.error('Error deleting sponsor:', error);
      res.status(500).json({ message: 'Error deleting sponsor' });
    }
  });

  // Create client app
  app.post('/api/client-apps', async (req, res) => {
    try {
      const { name, bundleId, iconUrl, bannerUrl, description } = req.body;

      if (!name || !bundleId) {
        return res.status(400).json({
          message: 'name and bundleId are required'
        });
      }

      // The new app belongs to the creator's tenant (ADR-0007).
      const userId = createOwnerId(req.operator, req.body.userId);

      const apiKey = `${name.toLowerCase().replace(/\s+/g, '_')}_api_key_${randomUUID().replace(/-/g, '').substring(0, 16)}`;

      const app = await storage.createClientApp({
        userId,
        name,
        bundleId,
        apiKey,
        ...(iconUrl && { iconUrl }),
        ...(bannerUrl && { bannerUrl }),
        ...(description && { description }),
      });
      res.status(201).json(app);
    } catch (error) {
      console.error('Error creating client app:', error);
      res.status(400).json({
        message: 'Error creating client app',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Update client app (requires userId for ownership verification)
  app.patch('/api/client-apps/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { userId, ...updateData } = req.body;

      if (!userId) {
        return res.status(400).json({ message: 'userId is required in request body' });
      }

      const existingApp = await storage.getClientApp(id);
      if (!existingApp) {
        return res.status(404).json({ message: 'Client app not found' });
      }

      // Verify ownership
      if (existingApp.userId !== userId) {
        return res.status(403).json({ message: 'Access denied' });
      }

      const app = await storage.updateClientApp(id, updateData);
      res.json(app);
    } catch (error) {
      console.error('Error updating client app:', error);
      res.status(500).json({ message: 'Error updating client app' });
    }
  });

  // Regenerate API key for client app (requires userId for ownership verification)
  app.post('/api/client-apps/:id/regenerate-key', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ message: 'userId is required in request body' });
      }

      const existingApp = await storage.getClientApp(id);

      if (!existingApp) {
        return res.status(404).json({ message: 'Client app not found' });
      }

      // Verify ownership
      if (existingApp.userId !== userId) {
        return res.status(403).json({ message: 'Access denied' });
      }

      // Generate a new unique API key
      const newApiKey = `${existingApp.name.toLowerCase().replace(/\s+/g, '_')}_api_key_${randomUUID().replace(/-/g, '').substring(0, 16)}`;

      const app = await storage.updateClientApp(id, { apiKey: newApiKey });
      res.json(app);
    } catch (error) {
      console.error('Error regenerating API key:', error);
      res.status(500).json({ message: 'Error regenerating API key' });
    }
  });

  // Delete client app (requires userId for ownership verification)
  app.delete('/api/client-apps/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const userIdParam = req.query.userId as string | undefined;

      if (!userIdParam) {
        return res.status(400).json({ message: 'userId query parameter is required' });
      }
      const userId = parseInt(userIdParam);
      if (isNaN(userId)) {
        return res.status(400).json({ message: 'Invalid userId parameter' });
      }

      const app = await storage.getClientApp(id);

      if (!app) {
        return res.status(404).json({ message: 'Client app not found' });
      }

      // Verify ownership
      if (app.userId !== userId) {
        return res.status(403).json({ message: 'Access denied' });
      }

      await storage.deleteClientApp(id);
      res.json({ message: 'Client app deleted successfully' });
    } catch (error) {
      console.error('Error deleting client app:', error);
      res.status(500).json({ message: 'Error deleting client app' });
    }
  });

  // Get channels for a client app
  app.get('/api/client-apps/:id/channels', async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      const channels = await storage.getClientAppChannels(appId);
      res.json(channels);
    } catch (error) {
      console.error('Error fetching channels:', error);
      res.status(500).json({ message: 'Error fetching channels' });
    }
  });

  // GET /api/client-apps/:id/components — RETIRED (migration 0004).
  // The legacy `app_components` table was dropped; the dashboard now reads
  // `/api/client-apps/:id/placements` (named instances) and
  // `/api/client-apps/:id/component-locations` (slot manifest). The route
  // returns 410 Gone with a pointer so old dashboard builds fail loudly.
  app.get('/api/client-apps/:id/components', async (_req, res) => {
    res.status(410).json({
      error: 'gone',
      message: 'Legacy `app_components` retired. Use GET /api/client-apps/:id/placements + /api/client-apps/:id/component-locations.',
    });
  });

  /**
   * Dashboard-only read endpoint for the locations registered by the SDK
   * manifest upload. Used by the operator's "Add placement" dialog so the
   * location picker matches what the dev's app actually exposes.
   *
   * No auth on this read mirrors the rest of `/api/client-apps/:id/...`.
   * (Session auth on the dashboard is enforced upstream by Vite + the
   * frontend route guard, not by this Express endpoint.)
   */
  app.get('/api/client-apps/:id/component-locations', async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      const locations = await storage.getAppComponentLocations(appId);
      res.json(locations);
    } catch (error) {
      console.error('Error fetching app component locations:', error);
      res.status(500).json({ message: 'Error fetching app component locations' });
    }
  });

  /**
   * Named app placements (post-2026-04-27 model: created by dashboard, not
   * SDK manifest). Each row is a (template, location, name) tuple the
   * operator declared via `/apps/:id` "Add from library" form.
   *
   * Returns rows joined with the canonical template so the picker can
   * render `{name} (type, location)`.
   *
   * `?includeDeprecated=true` includes soft-deleted rows for admin views.
   * Default omits them.
   */
  app.get('/api/client-apps/:id/placements', async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      const includeDeprecated = req.query.includeDeprecated === 'true' || req.query.includeDeprecated === '1';
      const placements = await storage.getAppPlacements(appId, includeDeprecated);
      res.json(placements);
    } catch (error) {
      console.error('Error fetching app placements:', error);
      res.status(500).json({ message: 'Error fetching app placements' });
    }
  });

  /**
   * Create a named placement for an app. Operator-driven (dashboard form):
   * pick template + name + locationId. Backend validates the chosen
   * locationId is one the SDK declared (and not deprecated), and the
   * template is canonical (`is_template = true`).
   *
   * Body: `{ componentId, locationId, name, customConfig?, createdBy? }`.
   *
   * Errors (HTTP 400 with `code` field for dashboard branching):
   *   - PLACEMENT_LOCATION_INVALID — location not declared (or deprecated)
   *   - PLACEMENT_TEMPLATE_INVALID — componentId not in canonical library
   *   - PLACEMENT_NAME_COLLISION   — name already used (active row)
   *   - PLACEMENT_SLOT_COLLISION   — (template, location) slot already claimed
   */
  app.post('/api/client-apps/:id/placements', async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      const { componentId, locationId, name, customConfig, createdBy } = req.body ?? {};
      if (!componentId || !locationId || !name) {
        return res.status(400).json({ error: 'componentId, locationId, and name are required' });
      }
      const placement = await storage.createAppPlacement({
        clientAppId: appId,
        componentId: String(componentId),
        locationId: String(locationId),
        name: String(name).trim(),
        customConfig: customConfig ?? null,
        createdBy: createdBy ? Number(createdBy) : undefined,
      });
      res.status(201).json(placement);
    } catch (error: any) {
      if (error?.code?.startsWith('PLACEMENT_')) {
        return res.status(400).json({ code: error.code, error: error.message });
      }
      console.error('Error creating app placement:', error);
      res.status(500).json({ error: 'Failed to create app placement' });
    }
  });

  /**
   * Soft-delete an app placement. Sets `deprecated_at = now()`. Existing
   * `campaign_components` referencing this placement keep rendering — the
   * dashboard surfaces the deprecated state with a warning so operators
   * can clean up at their own pace.
   *
   * Emits WebSocket `app_placement_deprecated` (campaign-scoped fan-out for
   * any campaign currently using this placement) so live SDK clients can
   * react in real-time.
   */
  app.delete('/api/client-apps/:id/placements/:placementId', async (req, res) => {
    try {
      const placementId = parseInt(req.params.placementId);
      if (Number.isNaN(placementId)) return res.status(400).json({ error: 'Invalid placementId' });
      const row = await storage.deprecateAppPlacement(placementId);

      // Find any active campaigns using this placement and broadcast the
      // deprecation event so connected clients can update warnings live.
      const campaignsAffected = await db
        .selectDistinct({ campaignId: campaignComponents.campaignId })
        .from(campaignComponents)
        .where(eq(campaignComponents.appPlacementId, placementId));

      for (const { campaignId } of campaignsAffected) {
        broadcastToCampaign(campaignId, JSON.stringify({
          type: 'app_placement_deprecated',
          campaignId,
          appPlacementId: placementId,
          name: row.name,
          deprecatedAt: row.deprecatedAt,
        }));
      }

      res.json({ success: true, placement: row, campaignsAffected: campaignsAffected.length });
    } catch (error: any) {
      if (error?.code === 'PLACEMENT_NOT_FOUND') {
        return res.status(404).json({ code: error.code, error: error.message });
      }
      console.error('Error deprecating app placement:', error);
      res.status(500).json({ error: 'Failed to deprecate app placement' });
    }
  });

  // POST /api/client-apps/:id/components — RETIRED (migration 0004).
  // Use POST /api/client-apps/:id/placements (named instances).
  app.post('/api/client-apps/:id/components', async (_req, res) => {
    res.status(410).json({
      error: 'gone',
      message: 'Legacy app_components endpoint retired. Use POST /api/client-apps/:id/placements with { componentId, locationId, name }.',
    });
  });

  // DELETE /api/client-apps/:id/components/:componentId — RETIRED.
  app.delete('/api/client-apps/:id/components/:componentId', async (_req, res) => {
    res.status(410).json({
      error: 'gone',
      message: 'Legacy app_components endpoint retired. Use DELETE /api/client-apps/:id/placements/:placementId (soft delete).',
    });
  });

  // Get campaigns for a specific app (includes both clientAppId-linked and channel-linked)
  app.get('/api/client-apps/:id/campaigns', async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      const appChannels = await storage.getClientAppChannels(appId);
      const appChannelIds = new Set(appChannels.map(ch => ch.id));
      const allCampaigns = await storage.getAllCampaigns();
      const appCampaigns = allCampaigns.filter(c =>
        c.clientAppId === appId || (c.channelId && appChannelIds.has(c.channelId))
      );
      const countMap = await storage.getBroadcastCountsForCampaigns(appCampaigns.map(c => c.id));
      const enriched = appCampaigns.map(c => ({ ...c, broadcastCount: countMap.get(c.id) || 0 }));
      res.json(enriched);
    } catch (error) {
      console.error('Error fetching app campaigns:', error);
      res.status(500).json({ message: 'Error fetching app campaigns' });
    }
  });

  // Get all channels for a user (across all their client apps)
  app.get('/api/channels', async (req, res) => {
    try {
      const userIdParam = req.query.userId as string | undefined;

      if (!userIdParam) {
        return res.status(400).json({
          message: 'userId query parameter is required'
        });
      }

      const userId = parseInt(userIdParam);
      if (isNaN(userId)) {
        return res.status(400).json({ message: 'Invalid userId' });
      }

      const channels = await storage.getUserChannels(userId);
      res.json(channels);
    } catch (error) {
      console.error('Error fetching user channels:', error);
      res.status(500).json({ message: 'Error fetching channels' });
    }
  });

  // Campaign CRUD endpoints

  // Create campaign (requires userId for multi-tenant scoping)
  app.post('/api/campaigns', async (req, res) => {
    try {
      const { clientAppId } = req.body;

      // Campaign belongs to the creator's tenant; the app + sponsor below must
      // belong to that same tenant (ADR-0007). An operator can only build
      // campaigns on its admin's apps/sponsors.
      const userId = createOwnerId(req.operator, req.body.userId);

      if (clientAppId) {
        const app = await storage.getClientApp(clientAppId);
        if (!app) {
          return res.status(404).json({ message: 'Client app not found' });
        }
        if (app.userId !== userId) {
          return res.status(403).json({ message: 'Access denied - app does not belong to this user' });
        }
      }

      // Multi-sponsor redesign: primarySponsorId is required at creation.
      // Accept legacy `sponsorId` as an alias for backwards compat during rollout.
      const primarySponsorId = req.body.primarySponsorId ?? req.body.sponsorId;
      if (!primarySponsorId) {
        return res.status(400).json({ message: 'primarySponsorId is required — select a primary sponsor' });
      }
      const sponsor = await storage.getSponsor(Number(primarySponsorId));
      if (!sponsor) {
        return res.status(404).json({ message: 'Primary sponsor not found' });
      }
      if (sponsor.userId !== userId) {
        return res.status(403).json({ message: 'Access denied - sponsor does not belong to this user' });
      }

      const campaignData = { ...req.body, userId, primarySponsorId: Number(primarySponsorId) };
      if (campaignData.startDate) {
        campaignData.startDate = new Date(campaignData.startDate);
      }
      if (campaignData.endDate) {
        campaignData.endDate = new Date(campaignData.endDate);
      }
      if (campaignData.matchStartTime) {
        campaignData.matchStartTime = new Date(campaignData.matchStartTime);
      }

      const campaign = await storage.createCampaign(campaignData);
      res.status(201).json(campaign);
    } catch (error) {
      console.error('Error creating campaign:', error);
      res.status(400).json({
        message: 'Error creating campaign',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Get campaigns (requires userId for multi-tenant isolation)
  app.get('/api/campaigns', async (req, res) => {
    try {
      // Scoped to the operator's tenant (ADR-0007); super_admin sees all.
      const owner = readScopeOwnerId(req.operator);

      const userCampaigns = owner === null
        ? await storage.getAllCampaigns()
        : await storage.getUserCampaigns(owner);
      const campaignIds = userCampaigns.map(c => c.id);
      const [countMap, componentCountMap, engagementMap, sponsors] = await Promise.all([
        storage.getBroadcastCountsForCampaigns(campaignIds),
        storage.getComponentCountsForCampaigns(campaignIds),
        storage.getCampaignEngagementTotals(campaignIds),
        owner === null ? storage.getAllSponsors() : storage.getUserSponsors(owner),
      ]);

      const sponsorMap = new Map(sponsors.map(s => [s.id, s]));

      const enriched = userCampaigns.map(c => {
        const sponsor = sponsorMap.get(c.primarySponsorId);
        return {
          ...c,
          broadcastCount: countMap.get(c.id) || 0,
          componentCount: componentCountMap.get(c.id) || 0,
          totalEngagement: engagementMap.get(c.id) || 0,
          sponsorName: sponsor?.name,
          sponsorAvatarUrl: sponsor?.avatarUrl,
        };
      });

      res.json(enriched);
    } catch (error) {
      console.error('Error fetching campaigns:', error);
      res.status(500).json({ message: 'Error fetching campaigns' });
    }
  });

  // Bulk broadcast counts per campaign — frontend `app-detail.tsx` posts a
  // CSV `?ids=38,39,…` and expects `{ [campaignId]: count }`. Must be
  // declared BEFORE `/api/campaigns/:id` so Express doesn't capture
  // "broadcast-counts" as the `:id` param (yields NaN → SQL 500).
  app.get('/api/campaigns/broadcast-counts', async (req, res) => {
    try {
      const raw = (req.query.ids as string | undefined) ?? '';
      const ids = raw
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isFinite(n));
      if (ids.length === 0) return res.json({});

      const counts: Record<number, number> = {};
      await Promise.all(
        ids.map(async (id) => {
          const broadcasts = await storage.getBroadcastsByCampaign(id);
          counts[id] = broadcasts.length;
        })
      );
      res.json(counts);
    } catch (error) {
      console.error('Error fetching broadcast counts:', error);
      res.status(500).json({ message: 'Error fetching broadcast counts' });
    }
  });

  // Get single campaign
  app.get('/api/campaigns/:id', async (req, res) => {
    try {
      const campaign = await storage.getCampaign(parseInt(req.params.id));
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }
      let clientAppName: string | null = null;
      let channelName: string | null = null;
      if (campaign.clientAppId) {
        const clientApp = await storage.getClientApp(campaign.clientAppId);
        if (clientApp) clientAppName = clientApp.name;
      }
      if (campaign.channelId) {
        const channel = await storage.getChannel(campaign.channelId);
        if (channel) channelName = channel.name;
      }
      const campaignSponsors = await storage.getCampaignSponsors(campaign.id);
      res.json({ ...campaign, clientAppName, channelName, sponsors: campaignSponsors });
    } catch (error) {
      console.error('Error fetching campaign:', error);
      res.status(500).json({ message: 'Error fetching campaign' });
    }
  });

  // GET /api/campaigns/:id/sponsors
  // GET /api/campaigns/:id/sponsors
  // Returns primary sponsor (from campaigns.primary_sponsor_id) + all secondaries
  // (from campaign_sponsors). Primary is first in the array with role='primary',
  // id=null (no campaign_sponsors row exists for it — it's a logical entry).
  // This single source of truth keeps the dashboard consistent across every
  // place that needs to show "all sponsors of this campaign":
  // - campaign-dashboard Sponsors tab
  // - broadcast-detail Add Slot + Quick Fire dropdowns
  // - future callers
  //
  // Consumers that want ONLY secondaries use /api/campaigns/:id/secondary-sponsors.
  app.get('/api/campaigns/:id/sponsors', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const [campaign, secondaries] = await Promise.all([
        storage.getCampaign(campaignId),
        storage.getCampaignSponsors(campaignId),
      ]);

      const result: any[] = [];
      if (campaign?.primarySponsorId) {
        const primary = await storage.getSponsor(campaign.primarySponsorId);
        if (primary) {
          result.push({
            id: null,
            sponsorId: primary.id,
            campaignId,
            role: 'primary',
            name: primary.name,
            logoUrl: primary.logoUrl,
            primaryColor: primary.primaryColor,
            secondaryColor: primary.secondaryColor,
          });
        }
      }
      // Drop any accidental duplicate where primary is also in campaign_sponsors
      // (shouldn't happen post de-dupe, but defensive).
      const primarySponsorId = campaign?.primarySponsorId ?? null;
      for (const s of secondaries) {
        if (s.sponsorId === primarySponsorId) continue;
        result.push(s);
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch campaign sponsors' });
    }
  });

  // POST /api/campaigns/:id/sponsors
  app.post('/api/campaigns/:id/sponsors', async (req, res) => {
    try {
      const parsed = insertCampaignSponsorSchema.safeParse({ ...req.body, campaignId: parseInt(req.params.id) });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const result = await storage.addCampaignSponsor(parsed.data);
      res.status(201).json(result);
    } catch (error: any) {
      if (error?.code === '23505') return res.status(409).json({ error: 'Sponsor already linked to this campaign' });
      res.status(500).json({ error: 'Failed to add sponsor to campaign' });
    }
  });

  // DELETE /api/campaigns/:id/sponsors/:sponsorId
  app.delete('/api/campaigns/:id/sponsors/:sponsorId', async (req, res) => {
    try {
      await storage.removeCampaignSponsor(parseInt(req.params.id), parseInt(req.params.sponsorId));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to remove sponsor from campaign' });
    }
  });

  app.get('/api/campaigns/:id/stats', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }
      const broadcasts = await storage.getCampaignBroadcasts(campaignId);
      let totalViews = 0;
      let totalEngagement = 0;
      let engagementCount = 0;
      let totalPollResponses = 0;
      let liveBroadcasts = 0;
      let upcomingBroadcasts = 0;
      let endedBroadcasts = 0;
      let totalPolls = 0;
      let totalContests = 0;

      for (const broadcast of broadcasts) {
        if (broadcast.metadata && typeof broadcast.metadata === 'object') {
          const meta = broadcast.metadata as Record<string, unknown>;
          if (meta.viewers) totalViews += Number(meta.viewers) || 0;
          if (meta.engagement) {
            totalEngagement += Number(meta.engagement) || 0;
            engagementCount++;
          }
        }
        if (broadcast.status === 'live') liveBroadcasts++;
        else if (broadcast.status === 'upcoming') upcomingBroadcasts++;
        else if (broadcast.status === 'ended') endedBroadcasts++;

        const polls = await storage.getBroadcastPolls(broadcast.broadcastId);
        totalPolls += polls.length;
        for (const poll of polls) {
          totalPollResponses += poll.totalVotes || 0;
        }
        const contests = await storage.getBroadcastContests(broadcast.broadcastId);
        totalContests += contests.length;
      }

      res.json({
        totalViews,
        engagementRate: engagementCount > 0 ? Math.round((totalEngagement / engagementCount) * 10) / 10 : 0,
        totalPollResponses,
        totalPolls,
        totalContests,
        liveBroadcasts,
        upcomingBroadcasts,
        endedBroadcasts,
        totalBroadcasts: broadcasts.length,
      });
    } catch (error) {
      console.error('Error fetching campaign stats:', error);
      res.status(500).json({ message: 'Error fetching campaign stats' });
    }
  });

  app.get('/api/campaigns/:id/broadcasts', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }
      const broadcasts = await storage.getCampaignBroadcasts(campaignId);
      const enriched = await Promise.all(broadcasts.map(async (broadcast) => {
        const polls = await storage.getBroadcastPolls(broadcast.broadcastId);
        const contests = await storage.getBroadcastContests(broadcast.broadcastId);
        return {
          ...broadcast,
          pollCount: polls.length,
          activePollCount: polls.filter(p => p.isActive).length,
          contestCount: contests.length,
        };
      }));
      res.json(enriched);
    } catch (error) {
      console.error('Error fetching campaign broadcasts:', error);
      res.status(500).json({ message: 'Error fetching campaign broadcasts' });
    }
  });

  // Update campaign
  app.put('/api/campaigns/:id', async (req, res) => {
    try {
      // Validate request body with updateCampaignSchema
      const validatedData = updateCampaignSchema.parse(req.body);

      // Convert ISO date strings to Date objects if present
      const updateData: any = { ...validatedData };
      if (updateData.startDate !== undefined) {
        updateData.startDate = updateData.startDate ? new Date(updateData.startDate) : null;
      }
      if (updateData.endDate !== undefined) {
        updateData.endDate = updateData.endDate ? new Date(updateData.endDate) : null;
      }
      if (updateData.matchStartTime !== undefined) {
        updateData.matchStartTime = updateData.matchStartTime ? new Date(updateData.matchStartTime) : null;
      }

      const campaignId = parseInt(req.params.id);

      // Multi-sponsor redesign: reject changes to primary sponsor once child rows exist.
      const newPrimary = updateData.primarySponsorId;
      if (newPrimary !== undefined) {
        const existingCampaign = await storage.getCampaign(campaignId);
        if (existingCampaign) {
          if (existingCampaign.primarySponsorId && existingCampaign.primarySponsorId !== Number(newPrimary)) {
            const canChange = await storage.canChangePrimarySponsor(campaignId);
            if (!canChange) {
              return res.status(403).json({
                message: 'Primary sponsor is immutable once broadcasts, activations or cart intents exist for this campaign',
                code: 'PRIMARY_SPONSOR_LOCKED',
              });
            }
          }
          const sponsor = await storage.getSponsor(Number(newPrimary));
          if (!sponsor) {
            return res.status(404).json({ message: 'Sponsor not found' });
          }
          if (sponsor.userId !== existingCampaign.userId) {
            return res.status(403).json({ message: 'Access denied - sponsor does not belong to this user' });
          }
          updateData.primarySponsorId = Number(newPrimary);
        }
      }

      const campaign = await storage.updateCampaign(campaignId, updateData);
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }

      res.json(campaign);
    } catch (error) {
      console.error('Error updating campaign:', error);
      res.status(400).json({
        message: 'Error updating campaign',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Delete campaign
  app.delete('/api/campaigns/:id', async (req, res) => {
    try {
      await storage.deleteCampaign(parseInt(req.params.id));
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting campaign:', error);
      res.status(500).json({ message: 'Error deleting campaign' });
    }
  });

  // Toggle campaign pause/resume
  app.patch('/api/campaigns/:id/toggle-pause', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const campaign = await storage.getCampaign(campaignId);

      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }

      // Toggle isPaused state
      const newPausedState = campaign.isPaused === 'true' ? 'false' : 'true';
      const updatedCampaign = await storage.updateCampaign(campaignId, {
        isPaused: newPausedState
      });

      // Broadcast campaign state change to all connected clients
      const eventType = newPausedState === 'true' ? 'campaign_paused' : 'campaign_resumed';
      const wsEvent = {
        type: eventType,
        campaignId: campaignId,
        timestamp: new Date().toISOString()
      };

      // Log before broadcasting
      console.log(`🔔 [WebSocket] Broadcasting ${eventType} to campaign ${campaignId}`);
      broadcastToCampaign(campaignId, JSON.stringify(wsEvent));
      console.log(`✅ [WebSocket] Event sent: ${JSON.stringify(wsEvent)}`);

      res.json(updatedCampaign);
    } catch (error) {
      console.error('Error toggling campaign pause:', error);
      res.status(500).json({
        message: 'Error toggling campaign pause',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Get campaign engagement config
  app.get('/api/campaigns/:id/engagement-config', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const config = await storage.getCampaignEngagementConfig(campaignId);
      res.json(config || null);
    } catch (error) {
      console.error('Error fetching engagement config:', error);
      res.status(500).json({ message: 'Error fetching engagement config' });
    }
  });

  // Save campaign engagement config
  app.put('/api/campaigns/:id/engagement-config', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const config = await storage.upsertCampaignEngagementConfig({
        campaignId,
        ...req.body
      });

      // Broadcast config:updated event
      const campaign = await storage.getCampaign(campaignId);
      broadcastToCampaign(campaignId, JSON.stringify({
        type: 'config:updated',
        campaignId,
        matchId: campaign?.matchId || null,
        sections: ['engagement'],
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }));

      res.json(config);
    } catch (error) {
      console.error('Error saving engagement config:', error);
      res.status(500).json({ message: 'Error saving engagement config' });
    }
  });

  // Get campaign UI config
  app.get('/api/campaigns/:id/ui-config', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const config = await storage.getCampaignUiConfig(campaignId);
      res.json(config || null);
    } catch (error) {
      console.error('Error fetching UI config:', error);
      res.status(500).json({ message: 'Error fetching UI config' });
    }
  });

  // Save campaign UI config
  app.put('/api/campaigns/:id/ui-config', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const config = await storage.upsertCampaignUiConfig({
        campaignId,
        ...req.body
      });

      // Broadcast config:updated event
      const campaign = await storage.getCampaign(campaignId);
      broadcastToCampaign(campaignId, JSON.stringify({
        type: 'config:updated',
        campaignId,
        matchId: campaign?.matchId || null,
        sections: ['ui'],
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }));

      res.json(config);
    } catch (error) {
      console.error('Error saving UI config:', error);
      res.status(500).json({ message: 'Error saving UI config' });
    }
  });

  // Get campaign feature flags
  app.get('/api/campaigns/:id/feature-flags', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const flags = await storage.getCampaignFeatureFlags(campaignId);
      res.json(flags || null);
    } catch (error) {
      console.error('Error fetching feature flags:', error);
      res.status(500).json({ message: 'Error fetching feature flags' });
    }
  });

  // Save campaign feature flags
  app.put('/api/campaigns/:id/feature-flags', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const flags = await storage.upsertCampaignFeatureFlags({
        campaignId,
        ...req.body
      });

      // Broadcast config:updated event
      const campaign = await storage.getCampaign(campaignId);
      broadcastToCampaign(campaignId, JSON.stringify({
        type: 'config:updated',
        campaignId,
        matchId: campaign?.matchId || null,
        sections: ['features'],
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }));

      res.json(flags);
    } catch (error) {
      console.error('Error saving feature flags:', error);
      res.status(500).json({ message: 'Error saving feature flags' });
    }
  });

  // Get campaign events
  app.get('/api/campaigns/:id/events', async (req, res) => {
    try {
      const events = await storage.getCampaignEvents(
        parseInt(req.params.id),
        req.query.limit ? parseInt(req.query.limit as string) : 50
      );
      res.json(events);
    } catch (error) {
      console.error('Error fetching campaign events:', error);
      res.status(500).json({ message: 'Error fetching campaign events' });
    }
  });

  // Scheduled Components Routes

  // Get scheduled components for a campaign
  app.get('/api/campaigns/:id/scheduled-components', async (req, res) => {
    try {
      const components = await storage.getCampaignScheduledComponents(parseInt(req.params.id));

      // Enrich custom components with component details
      const enrichedComponents = await Promise.all(
        components.map(async (comp) => {
          if (comp.type === 'custom_component' &&
            comp.data &&
            typeof comp.data === 'object' &&
            'componentId' in comp.data &&
            typeof comp.data.componentId === 'string') {
            const componentDetails = await storage.getComponentById(comp.data.componentId);
            return {
              ...comp,
              componentDetails
            };
          }
          return comp;
        })
      );

      res.json(enrichedComponents);
    } catch (error) {
      console.error('Error fetching scheduled components:', error);
      res.status(500).json({ message: 'Error fetching scheduled components' });
    }
  });

  // Create scheduled component
  app.post('/api/campaigns/:id/scheduled-components', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const { type, scheduledTime, endTime, data } = req.body;

      if (!type || !scheduledTime || !data) {
        return res.status(400).json({ message: 'Missing required fields' });
      }

      // Validate custom component exists and get its type
      let componentType = type;
      let componentName = type;

      if (type === 'custom_component') {
        if (!data.componentId) {
          return res.status(400).json({ message: 'componentId is required for custom components' });
        }
        const existingComponent = await storage.getComponentById(data.componentId);
        if (!existingComponent) {
          return res.status(404).json({ message: 'Component not found' });
        }
        componentType = existingComponent.type;
        componentName = existingComponent.name;
      }

      // Check for overlapping scheduled components of the same type
      const allScheduled = await storage.getCampaignScheduledComponents(campaignId);
      const newStart = new Date(scheduledTime);
      const newEnd = endTime ? new Date(endTime) : null;

      for (const scheduled of allScheduled) {
        if (scheduled.status === 'cancelled') continue;

        // Determine the type of the scheduled component
        let scheduledType = scheduled.type;
        if (scheduled.type === 'custom_component' && scheduled.data && typeof scheduled.data === 'object' && 'componentId' in scheduled.data) {
          const comp = await storage.getComponentById(scheduled.data.componentId as string);
          if (comp) {
            scheduledType = comp.type;
          }
        }

        // Only check components of the same type
        if (scheduledType !== componentType) continue;

        const existingStart = new Date(scheduled.scheduledTime);
        const existingEnd = scheduled.endTime ? new Date(scheduled.endTime) : null;

        // Check for overlap
        const hasOverlap = (() => {
          // If new component has no end time (runs indefinitely), check if it starts before existing ends
          if (!newEnd) {
            return !existingEnd || newStart < existingEnd;
          }

          // If existing has no end time, check if new overlaps with its start
          if (!existingEnd) {
            return newEnd > existingStart;
          }

          // Both have end times - check for any overlap
          return newStart < existingEnd && newEnd > existingStart;
        })();

        if (hasOverlap) {
          let scheduledName = scheduled.type;
          if (scheduled.type === 'custom_component' && scheduled.data && typeof scheduled.data === 'object' && 'componentId' in scheduled.data) {
            const comp = await storage.getComponentById(scheduled.data.componentId as string);
            if (comp) scheduledName = comp.name;
          }

          return res.status(409).json({
            message: `Time conflict: Another ${componentType} component "${scheduledName}" is already scheduled during this time period. Only one component of each type can be active at a time.`,
            conflictingSchedule: {
              id: scheduled.id,
              type: scheduledType,
              name: scheduledName,
              scheduledTime: scheduled.scheduledTime,
              endTime: scheduled.endTime
            }
          });
        }
      }

      // Resolve sponsor: accept explicit sponsorId, or default to campaign primary.
      // Sponsor must be primary OR one of the campaign's secondary sponsors.
      const campaignForSponsor = await storage.getCampaign(campaignId);
      if (!campaignForSponsor || !campaignForSponsor.primarySponsorId) {
        return res.status(400).json({ message: 'Campaign has no primary sponsor' });
      }
      const requestedSponsorId: number = req.body.sponsorId ? Number(req.body.sponsorId) : campaignForSponsor.primarySponsorId;
      const sponsorAllowed = await storage.isSponsorAllowedForCampaign(requestedSponsorId, campaignId);
      if (!sponsorAllowed) {
        return res.status(400).json({ message: 'Sponsor is not associated with this campaign (must be primary or secondary)' });
      }

      const component = await storage.createScheduledComponent({
        campaignId,
        sponsorId: requestedSponsorId,
        type,
        scheduledTime: new Date(scheduledTime),
        endTime: endTime ? new Date(endTime) : undefined,
        data,
        status: 'pending'
      });

      res.status(201).json(component);
    } catch (error) {
      console.error('Error creating scheduled component:', error);
      res.status(400).json({
        message: 'Error creating scheduled component',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Update scheduled component
  app.patch('/api/scheduled-components/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { type, scheduledTime, endTime, data } = req.body;

      // Get current scheduled component
      const current = await storage.getScheduledComponent(id);
      if (!current) {
        return res.status(404).json({ message: 'Scheduled component not found' });
      }

      // Determine the component type for validation
      let componentType = type || current.type;
      let componentName = componentType;

      if (componentType === 'custom_component') {
        const componentId = data?.componentId || (current.data && typeof current.data === 'object' && 'componentId' in current.data ? current.data.componentId : null);
        if (componentId) {
          const existingComponent = await storage.getComponentById(componentId as string);
          if (!existingComponent) {
            return res.status(404).json({ message: 'Component not found' });
          }
          componentType = existingComponent.type;
          componentName = existingComponent.name;
        }
      }

      // Check for overlapping scheduled components of the same type (if time is being updated)
      if (scheduledTime !== undefined || endTime !== undefined) {
        const allScheduled = await storage.getCampaignScheduledComponents(current.campaignId);
        const newStart = scheduledTime ? new Date(scheduledTime) : new Date(current.scheduledTime);
        const newEnd = endTime !== undefined ? (endTime ? new Date(endTime) : null) : (current.endTime ? new Date(current.endTime) : null);

        for (const scheduled of allScheduled) {
          if (scheduled.id === id || scheduled.status === 'cancelled') continue;

          // Determine the type of the scheduled component
          let scheduledType = scheduled.type;
          if (scheduled.type === 'custom_component' && scheduled.data && typeof scheduled.data === 'object' && 'componentId' in scheduled.data) {
            const comp = await storage.getComponentById(scheduled.data.componentId as string);
            if (comp) {
              scheduledType = comp.type;
            }
          }

          // Only check components of the same type
          if (scheduledType !== componentType) continue;

          const existingStart = new Date(scheduled.scheduledTime);
          const existingEnd = scheduled.endTime ? new Date(scheduled.endTime) : null;

          // Check for overlap
          const hasOverlap = (() => {
            if (!newEnd) {
              return !existingEnd || newStart < existingEnd;
            }
            if (!existingEnd) {
              return newEnd > existingStart;
            }
            return newStart < existingEnd && newEnd > existingStart;
          })();

          if (hasOverlap) {
            let scheduledName = scheduled.type;
            if (scheduled.type === 'custom_component' && scheduled.data && typeof scheduled.data === 'object' && 'componentId' in scheduled.data) {
              const comp = await storage.getComponentById(scheduled.data.componentId as string);
              if (comp) scheduledName = comp.name;
            }

            return res.status(409).json({
              message: `Time conflict: Another ${componentType} component "${scheduledName}" is already scheduled during this time period. Only one component of each type can be active at a time.`,
              conflictingSchedule: {
                id: scheduled.id,
                type: scheduledType,
                name: scheduledName,
                scheduledTime: scheduled.scheduledTime,
                endTime: scheduled.endTime
              }
            });
          }
        }
      }

      const updateData: Partial<InsertScheduledComponent> = {};
      if (type !== undefined) updateData.type = type;
      if (scheduledTime !== undefined) updateData.scheduledTime = new Date(scheduledTime);
      if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;
      if (data !== undefined) updateData.data = data;

      const updated = await storage.updateScheduledComponent(id, updateData);

      if (!updated) {
        return res.status(404).json({ message: 'Scheduled component not found' });
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating scheduled component:', error);
      res.status(500).json({
        message: 'Error updating scheduled component',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Delete scheduled component
  app.delete('/api/scheduled-components/:id', async (req, res) => {
    try {
      await storage.deleteScheduledComponent(parseInt(req.params.id));
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting scheduled component:', error);
      res.status(500).json({ message: 'Error deleting scheduled component' });
    }
  });

  // Form state routes

  // Save form state
  app.post('/api/form-state', async (req, res) => {
    try {
      const { campaignId, formType, formData } = req.body;

      if (!campaignId || !formType || !formData) {
        return res.status(400).json({ message: 'Missing required fields' });
      }

      const state = await storage.saveFormState({
        campaignId: parseInt(campaignId),
        formType,
        formData
      });

      res.json(state);
    } catch (error) {
      console.error('Error saving form state:', error);
      res.status(500).json({ message: 'Error saving form state' });
    }
  });

  // Get specific form state
  app.get('/api/form-state/:campaignId/:formType', async (req, res) => {
    try {
      const state = await storage.getFormState(
        parseInt(req.params.campaignId),
        req.params.formType
      );

      if (!state) {
        return res.status(404).json({ message: 'Form state not found' });
      }

      res.json(state);
    } catch (error) {
      console.error('Error fetching form state:', error);
      res.status(500).json({ message: 'Error fetching form state' });
    }
  });

  // Get all form states for a campaign
  app.get('/api/form-state/:campaignId', async (req, res) => {
    try {
      const states = await storage.getAllFormStates(parseInt(req.params.campaignId));
      res.json(states);
    } catch (error) {
      console.error('Error fetching form states:', error);
      res.status(500).json({ message: 'Error fetching form states' });
    }
  });

  // Mock endpoint for Reachu channels
  app.get('/api/reachu/channels', async (req, res) => {
    try {
      // Mock data - in production this would fetch from Reachu API
      const mockChannels = [
        { id: 'ch_1', name: 'Electronics Store', productCount: 245 },
        { id: 'ch_2', name: 'Fashion & Apparel', productCount: 389 },
        { id: 'ch_3', name: 'Home & Garden', productCount: 156 },
        { id: 'ch_4', name: 'Sports Equipment', productCount: 92 },
        { id: 'ch_5', name: 'Beauty & Health', productCount: 178 }
      ];

      res.json(mockChannels);
    } catch (error) {
      console.error('Error fetching Reachu channels:', error);
      res.status(500).json({ message: 'Error fetching channels' });
    }
  });

  // Component Library Routes

  // Get all components
  app.get('/api/components', async (req, res) => {
    try {
      const components = await storage.getComponents();
      res.json(components);
    } catch (error) {
      console.error('Error fetching components:', error);
      res.status(500).json({ message: 'Error fetching components' });
    }
  });

  // Get component usage across campaigns
  app.get('/api/components/usage', async (req, res) => {
    try {
      const usage = await storage.getComponentUsage();
      res.json(usage);
    } catch (error) {
      console.error('Error fetching component usage:', error);
      res.status(500).json({ message: 'Error fetching component usage' });
    }
  });

  // Create new component
  app.post('/api/components', async (req, res) => {
    try {
      const { type, name, config } = req.body;

      if (!type || !name || !config) {
        return res.status(400).json({ message: 'Missing required fields: type, name, config' });
      }

      const component = await storage.createComponent({ type, name, config });
      res.status(201).json(component);
    } catch (error) {
      console.error('Error creating component:', error);
      res.status(500).json({ message: 'Error creating component' });
    }
  });

  // Get component by ID
  app.get('/api/components/:id', async (req, res) => {
    try {
      const component = await storage.getComponentById(req.params.id);

      if (!component) {
        return res.status(404).json({ message: 'Component not found' });
      }

      res.json(component);
    } catch (error) {
      console.error('Error fetching component:', error);
      res.status(500).json({ message: 'Error fetching component' });
    }
  });

  // Update component
  app.patch('/api/components/:id', async (req, res) => {
    try {
      const { type, name, config } = req.body;
      const updates: any = {};

      if (type !== undefined) updates.type = type;
      if (name !== undefined) updates.name = name;
      if (config !== undefined) updates.config = config;

      const component = await storage.updateComponent(req.params.id, updates);

      if (!component) {
        return res.status(404).json({ message: 'Component not found' });
      }

      // Broadcast config update to all campaigns using this component
      const allCampaigns = await storage.getAllCampaigns();
      for (const campaign of allCampaigns) {
        // Only broadcast to active campaigns
        if (!isCampaignActive(campaign)) {
          continue;
        }

        const campaignComponents = await storage.getCampaignComponents(campaign.id);
        const isUsed = campaignComponents.some(cc => cc.componentId === req.params.id);

        if (isUsed) {
          const campaignComponent = campaignComponents.find(cc => cc.componentId === req.params.id);
          const event: any = {
            type: 'component_config_updated',
            campaignId: campaign.id,
            componentId: req.params.id,
            component: {
              id: component.id,
              type: component.type,
              name: component.name,
              config: normalizeUrls(updates.config || component.config, req.protocol, req.get('host'))
            }
          };
          // Include matchId if component or campaign is associated with a match
          if (campaignComponent?.matchId) {
            event.matchId = campaignComponent.matchId;
          } else if (campaign.matchId) {
            event.matchId = campaign.matchId;
          }
          broadcastToCampaignImpl(campaign.id, JSON.stringify(event));
        }
      }

      res.json(component);
    } catch (error) {
      console.error('Error updating component:', error);
      res.status(500).json({ message: 'Error updating component' });
    }
  });

  // Delete component
  app.delete('/api/components/:id', async (req, res) => {
    try {
      await storage.deleteComponent(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting component:', error);
      res.status(500).json({ message: 'Error deleting component' });
    }
  });

  // Campaign Component Routes

  // Get components for a campaign
  app.get('/api/campaigns/:id/components', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const components = await storage.getCampaignComponents(campaignId);
      res.json(components);
    } catch (error) {
      console.error('Error fetching campaign components:', error);
      res.status(500).json({ message: 'Error fetching campaign components' });
    }
  });

  // Get active components for a campaign (for iOS app initial state)
  app.get('/api/campaigns/:id/active-components', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);

      // Check if campaign exists and is active
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }

      if (!isCampaignActive(campaign)) {
        // Campaign has ended, return empty array
        return res.json([]);
      }

      const allComponents = await storage.getCampaignComponents(campaignId);

      // Filter only active components and format for iOS consumption
      const activeComponents = allComponents
        .filter(cc => cc.status === 'active')
        .map(cc => ({
          componentId: cc.component.id,
          type: cc.component.type,
          name: cc.component.name,
          // Use campaign-specific customConfig if available, otherwise use component's default config
          config: normalizeUrls(cc.customConfig || cc.component.config, req.protocol, req.get('host')),
          status: cc.status,
          activatedAt: cc.activatedAt,
          sponsor: cc.sponsor,
        }));

      res.json(activeComponents);
    } catch (error) {
      console.error('Error fetching active campaign components:', error);
      res.status(500).json({ message: 'Error fetching active campaign components' });
    }
  });

  // Add placement to campaign (post-2026-04-27 model: references an
  // app_placement instead of (componentId, locationId) pair).
  //
  // Body: `{ appPlacementId, sponsorId, status?, instanceName?,
  //          customConfig?, broadcastId?, createdBy? }`.
  //
  // Validates:
  //   - app_placement exists, not deprecated, belongs to the same clientApp as the campaign
  //   - sponsor is primary or in campaign_sponsors
  //   - if status='active', no other active row for same (campaign, app_placement)
  //     (defense-in-depth — DB partial UNIQUE index also enforces)
  app.post('/api/campaigns/:id/components', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const { appPlacementId, status, instanceName, sponsorId, broadcastId, customConfig, createdBy } = req.body ?? {};

      if (!appPlacementId) {
        return res.status(400).json({ message: 'Missing required field: appPlacementId' });
      }

      // 1. Validate app_placement exists, not deprecated, same clientApp.
      const placement = await storage.getAppPlacementById(Number(appPlacementId));
      if (!placement) {
        return res.status(404).json({ message: `App placement ${appPlacementId} not found` });
      }
      if (placement.deprecatedAt) {
        return res.status(400).json({ message: `App placement ${appPlacementId} is deprecated; cannot bind new instances` });
      }

      // 2. Validate campaign + clientApp match.
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }
      if (placement.clientAppId !== campaign.clientAppId) {
        return res.status(400).json({
          message: `App placement belongs to clientApp ${placement.clientAppId}, but campaign is for clientApp ${campaign.clientAppId}`,
        });
      }
      if (!campaign.primarySponsorId) {
        return res.status(400).json({ message: 'Campaign has no primary sponsor' });
      }

      // 3. Validate sponsor.
      const requestedSponsorId: number = sponsorId ? Number(sponsorId) : campaign.primarySponsorId;
      const sponsorAllowed = await storage.isSponsorAllowedForCampaign(requestedSponsorId, campaignId);
      if (!sponsorAllowed) {
        return res.status(400).json({ message: 'Sponsor is not associated with this campaign (must be primary or secondary)' });
      }

      // 4. Multi-sponsor "one active per (campaign, placement)" — partial
      //    UNIQUE index on the DB enforces this; we pre-check for a clearer
      //    400 error so the dashboard can surface the in-use sponsor.
      if ((status || 'inactive') === 'active') {
        const existing = await db.select({ id: campaignComponents.id, sponsorId: campaignComponents.sponsorId })
          .from(campaignComponents)
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.appPlacementId, Number(appPlacementId)),
            eq(campaignComponents.status, 'active'),
          ))
          .limit(1);
        if (existing.length > 0) {
          return res.status(409).json({
            code: 'PLACEMENT_ACTIVE_CONFLICT',
            message: `Placement is already active in this campaign with sponsor ${existing[0].sponsorId}. Deactivate it first or schedule a rotation.`,
            activeCampaignComponentId: existing[0].id,
          });
        }
      }

      // 5. Generate sequential instanceName if not provided.
      let finalInstanceName = instanceName;
      if (!finalInstanceName) {
        const existingComponents = await storage.getCampaignComponents(campaignId);
        const sameTemplateInstances = existingComponents.filter(cc => cc.appPlacementId === Number(appPlacementId));
        const sdkName = componentSDKNames[placement.component.type as keyof typeof componentSDKNames] || placement.name;
        const instancePattern = new RegExp(`^${sdkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
        let maxNumber = 0;
        for (const instance of sameTemplateInstances) {
          if (!instance.instanceName) continue;
          const match = instance.instanceName.match(instancePattern);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNumber) maxNumber = num;
          }
        }
        finalInstanceName = `${sdkName} ${maxNumber + 1}`;
      }

      const broadcastScope: string | null = broadcastId ? String(broadcastId) : null;

      const campaignComponent = await storage.addComponentToCampaign({
        campaignId,
        appPlacementId: Number(appPlacementId),
        sponsorId: requestedSponsorId,
        broadcastId: broadcastScope,
        instanceName: finalInstanceName,
        status: status || 'inactive',
        customConfig: customConfig ?? null,
        createdBy: createdBy ? Number(createdBy) : null,
      } as any);

      res.status(201).json(campaignComponent);
    } catch (error: any) {
      // DB partial UNIQUE index trips here if dashboard validation missed.
      if (error?.code === '23505' && /one_active/i.test(error?.message ?? '')) {
        return res.status(409).json({
          code: 'PLACEMENT_ACTIVE_CONFLICT',
          message: 'A row is already active for this (campaign, app_placement). Deactivate it first.',
        });
      }
      console.error('Error adding placement to campaign:', error);
      res.status(500).json({ message: 'Error adding placement to campaign' });
    }
  });

  // Update campaign component status (toggle ON/OFF)
  // PATCH /api/campaigns/:id/components/:componentId — toggle status / locationId.
  //
  // `:componentId` is the **campaign_components row PK** (a numeric id passed as
  // string from the URL). Pre-migration 0004 it was the FK to `components.id`
  // (template uuid); the column is gone and the routes now consistently
  // reference the row PK. The locationId update is a no-op shim — location is
  // immutable post-migration (lives on app_placements).
  app.patch('/api/campaigns/:id/components/:componentId', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const { componentId } = req.params;
      const { status, locationId } = req.body;

      if (!status && locationId === undefined) {
        return res.status(400).json({ message: 'Provide "status" and/or "locationId"' });
      }
      if (status && !['active', 'inactive'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be "active" or "inactive"' });
      }

      const rowId = parseInt(componentId);
      if (Number.isNaN(rowId)) {
        return res.status(400).json({ message: 'componentId must be a numeric campaign_components row id' });
      }

      // Multi-sponsor "one active per (campaign, app_placement)" — the partial
      // UNIQUE index on the DB enforces this; pre-check to surface a friendlier
      // 409 with the active row's id so the dashboard can prompt to deactivate.
      if (status === 'active') {
        const target = await db.select().from(campaignComponents)
          .where(eq(campaignComponents.id, rowId))
          .limit(1);
        if (target.length === 0) {
          return res.status(404).json({ message: 'Campaign component not found' });
        }
        const targetRow = target[0];
        if (targetRow.campaignId !== campaignId) {
          return res.status(404).json({ message: 'Campaign component not found in this campaign' });
        }
        const otherActive = await db.select({ id: campaignComponents.id, sponsorId: campaignComponents.sponsorId })
          .from(campaignComponents)
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.appPlacementId, targetRow.appPlacementId),
            eq(campaignComponents.status, 'active'),
            ne(campaignComponents.id, rowId),
          ))
          .limit(1);
        if (otherActive.length > 0) {
          return res.status(409).json({
            code: 'PLACEMENT_ACTIVE_CONFLICT',
            message: `Another row is already active for this placement (sponsor ${otherActive[0].sponsorId}). Deactivate it first.`,
            activeCampaignComponentId: otherActive[0].id,
          });
        }
      }

      // Atomic UPDATE + outbox enqueue. Both rows commit together (the
      // event is guaranteed to fire iff the data change persisted) or
      // both roll back on error. The worker (server/events/worker.ts)
      // ships the event to subscribed sockets within ~500ms.
      let updated: any;
      try {
        updated = await db.transaction(async (tx) => {
          let row: any;
          if (status) {
            const [r] = await tx.update(campaignComponents)
              .set({
                status,
                ...(status === 'active' ? { activatedAt: new Date() } : {}),
                updatedAt: new Date(),
              })
              .where(and(
                eq(campaignComponents.campaignId, campaignId),
                eq(campaignComponents.id, rowId),
              ))
              .returning();
            row = r;
            if (!row) return undefined;

            // Enqueue placement_status_changed inside the same tx.
            // Payload is minimal — status is a flag, the SDK already has
            // the rest of the component cached locally.
            await enqueueEvent(tx, {
              topic: PLACEMENT_TOPICS.STATUS_CHANGED,
              module: 'placements',
              scopeType: 'campaign',
              scopeId: campaignId,
              payload: {
                campaignId,
                appPlacementId: row.appPlacementId,
                campaignComponentId: row.id,
                status: row.status,
              },
            });
          }
          if (locationId !== undefined && !row) {
            // No-op shim — location_id is immutable post-migration 0004.
            // Read the current row so the response stays consistent.
            const [r] = await tx.select().from(campaignComponents)
              .where(and(
                eq(campaignComponents.campaignId, campaignId),
                eq(campaignComponents.id, rowId),
              ))
              .limit(1);
            row = r;
          }
          return row;
        });
      } catch (txErr: any) {
        // Partial UNIQUE index trip (defense-in-depth — pre-check above
        // catches the common case but a race between concurrent PATCHes
        // can still hit this).
        if (txErr?.code === '23505') {
          return res.status(409).json({
            code: 'PLACEMENT_ACTIVE_CONFLICT',
            message: 'A row is already active for this (campaign, app_placement). Deactivate it first.',
          });
        }
        throw txErr;
      }

      if (!updated) {
        return res.status(404).json({ message: 'Campaign component not found' });
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating campaign component status:', error);
      res.status(500).json({ message: 'Error updating campaign component status' });
    }
  });

  // Update campaign component custom configuration (and optionally
  // the placement's sponsor).
  //
  // Atomic UPDATE + outbox enqueue (Phase 3 of the live-updates sprint,
  // extended later to cover in-place sponsor swaps so the operator can
  // edit an active row without first pausing it).
  //
  // Body: `{ customConfig, sponsorId? }`.
  //   - `customConfig` is required (use `null` to clear / revert to
  //     template defaults).
  //   - `sponsorId` is optional. When present and different from the
  //     row's current sponsor, validates against campaign_sponsors and
  //     updates the row.
  //
  // Emits a single `placement_config_updated` event covering both the
  // customConfig change and the sponsor swap so the SDK applies them
  // atomically (SDK reads new sponsorId, ProductService picks the new
  // sponsor's commerce key on the next load).
  app.patch('/api/campaigns/:id/components/:componentId/config', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const { componentId } = req.params;
      const { customConfig, sponsorId: rawSponsorId } = req.body;

      // Allow null/undefined to clear customConfig and revert to template defaults
      if (customConfig === undefined) {
        return res.status(400).json({ message: 'Missing required field: customConfig (use null to clear)' });
      }

      const rowId = parseInt(componentId);
      if (Number.isNaN(rowId)) {
        return res.status(400).json({ message: 'componentId must be a numeric campaign_components row id' });
      }

      const sponsorIdProvided = rawSponsorId !== undefined && rawSponsorId !== null;
      const newSponsorId = sponsorIdProvided ? Number(rawSponsorId) : null;
      if (sponsorIdProvided && (Number.isNaN(newSponsorId as number) || (newSponsorId as number) <= 0)) {
        return res.status(400).json({ message: 'sponsorId must be a positive integer' });
      }
      if (sponsorIdProvided) {
        // Ensure the new sponsor is allowed for this campaign (primary or secondary).
        const allowed = await storage.isSponsorAllowedForCampaign(newSponsorId as number, campaignId);
        if (!allowed) {
          return res.status(400).json({ message: 'Sponsor is not associated with this campaign (must be primary or secondary)' });
        }
      }

      // Helper: extract `productIds: string[]` from a customConfig blob.
      // Used to compute the `productIdsChanged` hint sent to the SDK.
      // Returns [] if absent or malformed (treated as "no products
      // configured" in the diff).
      const extractProductIds = (cfg: unknown): string[] => {
        if (!cfg || typeof cfg !== 'object') return [];
        const ids = (cfg as Record<string, unknown>).productIds;
        if (!Array.isArray(ids)) return [];
        return ids.filter((x): x is string => typeof x === 'string');
      };

      // Atomic: read old config (for productIdsChanged diff), UPDATE,
      // enqueueEvent — all in one tx.
      const updated = await db.transaction(async (tx) => {
        const [before] = await tx.select({
          id: campaignComponents.id,
          customConfig: campaignComponents.customConfig,
          appPlacementId: campaignComponents.appPlacementId,
          sponsorId: campaignComponents.sponsorId,
          status: campaignComponents.status,
        })
          .from(campaignComponents)
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.id, rowId),
          ))
          .limit(1);

        if (!before) return undefined;

        const sponsorChanged = sponsorIdProvided && before.sponsorId !== newSponsorId;
        const updatePatch: Record<string, unknown> = {
          customConfig,
          updatedAt: new Date(),
        };
        if (sponsorChanged) {
          updatePatch.sponsorId = newSponsorId;
        }

        const [row] = await tx.update(campaignComponents)
          .set(updatePatch)
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.id, rowId),
          ))
          .returning();

        // Compute productIdsChanged hint for the SDK. Strict array
        // equality on the productIds field — order matters because the
        // operator may have re-ordered the carousel.
        const oldIds = extractProductIds(before.customConfig);
        const newIds = extractProductIds(customConfig);
        const productIdsChanged =
          oldIds.length !== newIds.length ||
          oldIds.some((id, i) => id !== newIds[i]);

        // Only emit if the row is active — paused placements are invisible
        // to the SDK, so a config change is just persisted for later.
        if (row.status === 'active') {
          await enqueueEvent(tx, {
            topic: PLACEMENT_TOPICS.CONFIG_UPDATED,
            module: 'placements',
            scopeType: 'campaign',
            scopeId: campaignId,
            payload: {
              campaignId,
              appPlacementId: row.appPlacementId,
              campaignComponentId: row.id,
              customConfig: customConfig ?? null,
              productIdsChanged,
              sponsorId: row.sponsorId,
              sponsorChanged,
            },
          });
        }

        return row;
      });

      if (!updated) {
        return res.status(404).json({ message: 'Campaign component not found' });
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating campaign component config:', error);
      res.status(500).json({ message: 'Error updating campaign component config' });
    }
  });

  // Remove component from campaign
  app.delete('/api/campaigns/:id/components/:componentId', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const { componentId } = req.params;

      await storage.removeComponentFromCampaign(campaignId, componentId);
      res.status(204).send();
    } catch (error) {
      console.error('Error removing component from campaign:', error);
      res.status(500).json({ message: 'Error removing component from campaign' });
    }
  });

  // ========================================
  // Live placement control (Phase 3 of live-updates sprint)
  //
  // Three operator-facing verbs that the dashboard wires to buttons:
  //
  //   POST /api/campaigns/:id/components/:componentId/pause
  //   POST /api/campaigns/:id/components/:componentId/resume
  //   POST /api/campaigns/:id/placements/:appPlacementId/activate
  //
  // All three flip campaign_components rows + enqueue an outbox event
  // INSIDE the same transaction. The worker (server/events/worker.ts)
  // ships the event to subscribed sockets within ~500ms; the SDK toggles
  // visibility (pause/resume) or swaps the active row (activate)
  // without a cold start.
  //
  // pause/resume are sugar around PATCH status — same atomicity, clearer
  // verbs for the dashboard. activate is the multi-sponsor rotation:
  // atomic A→B swap inside one tx, single placement_activation_swapped
  // event emitted (see server/events/types.ts for the payload shape).
  // ========================================

  // Pause a campaign_components row — sets status='inactive', emits
  // placement_status_changed. Always reversible via /resume.
  app.post('/api/campaigns/:id/components/:componentId/pause', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const rowId = parseInt(req.params.componentId);
      if (Number.isNaN(rowId)) {
        return res.status(400).json({ message: 'componentId must be a numeric campaign_components row id' });
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(campaignComponents)
          .set({ status: 'inactive', updatedAt: new Date() })
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.id, rowId),
          ))
          .returning();
        if (!row) return undefined;

        await enqueueEvent(tx, {
          topic: PLACEMENT_TOPICS.STATUS_CHANGED,
          module: 'placements',
          scopeType: 'campaign',
          scopeId: campaignId,
          payload: {
            campaignId,
            appPlacementId: row.appPlacementId,
            campaignComponentId: row.id,
            status: 'inactive',
          },
        });
        return row;
      });

      if (!updated) {
        return res.status(404).json({ message: 'Campaign component not found' });
      }
      res.json(updated);
    } catch (error) {
      console.error('Error pausing placement:', error);
      res.status(500).json({ message: 'Error pausing placement' });
    }
  });

  // Resume a campaign_components row — sets status='active', emits
  // placement_status_changed. Pre-checks the active-conflict (partial
  // UNIQUE index) so the dashboard surfaces a clean 409 with the row id
  // currently holding the slot.
  app.post('/api/campaigns/:id/components/:componentId/resume', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const rowId = parseInt(req.params.componentId);
      if (Number.isNaN(rowId)) {
        return res.status(400).json({ message: 'componentId must be a numeric campaign_components row id' });
      }

      // Read target row to get appPlacementId for the conflict check.
      const [target] = await db.select()
        .from(campaignComponents)
        .where(and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.id, rowId),
        ))
        .limit(1);
      if (!target) {
        return res.status(404).json({ message: 'Campaign component not found' });
      }

      const otherActive = await db.select({ id: campaignComponents.id, sponsorId: campaignComponents.sponsorId })
        .from(campaignComponents)
        .where(and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.appPlacementId, target.appPlacementId),
          eq(campaignComponents.status, 'active'),
          ne(campaignComponents.id, rowId),
        ))
        .limit(1);
      if (otherActive.length > 0) {
        return res.status(409).json({
          code: 'PLACEMENT_ACTIVE_CONFLICT',
          message: `Another row is already active for this placement (sponsor ${otherActive[0].sponsorId}). Use /activate to swap, or pause it first.`,
          activeCampaignComponentId: otherActive[0].id,
        });
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(campaignComponents)
          .set({ status: 'active', activatedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.id, rowId),
          ))
          .returning();
        if (!row) return undefined;

        await enqueueEvent(tx, {
          topic: PLACEMENT_TOPICS.STATUS_CHANGED,
          module: 'placements',
          scopeType: 'campaign',
          scopeId: campaignId,
          payload: {
            campaignId,
            appPlacementId: row.appPlacementId,
            campaignComponentId: row.id,
            status: 'active',
          },
        });
        return row;
      });

      if (!updated) {
        return res.status(404).json({ message: 'Campaign component not found' });
      }
      res.json(updated);
    } catch (error: any) {
      if (error?.code === '23505') {
        return res.status(409).json({
          code: 'PLACEMENT_ACTIVE_CONFLICT',
          message: 'A row is already active for this placement (race condition). Pause it first.',
        });
      }
      console.error('Error resuming placement:', error);
      res.status(500).json({ message: 'Error resuming placement' });
    }
  });

  // Activate a specific campaign_components row within a placement slot,
  // atomically deactivating whichever row is currently active. This is
  // the multi-sponsor rotation entry point.
  //
  // Body: `{ campaignComponentId: number }` — the row to make active.
  //
  // Three states possible:
  //   1. Target is already active → no-op (idempotent), returns 200 with
  //      the unchanged row.
  //   2. No prior active row → simple activation, emits
  //      `placement_status_changed`.
  //   3. Active row exists and is different → atomic swap (deactivate A,
  //      activate B in one tx), emits `placement_activation_swapped`
  //      with both ids.
  //
  // The order matters: deactivate FIRST, then activate, so the partial
  // UNIQUE index never sees two active rows simultaneously even within
  // the tx.
  app.post('/api/campaigns/:id/placements/:appPlacementId/activate', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const appPlacementId = parseInt(req.params.appPlacementId);
      const targetRowId = Number(req.body?.campaignComponentId);

      if (Number.isNaN(campaignId) || Number.isNaN(appPlacementId) || !Number.isFinite(targetRowId)) {
        return res.status(400).json({
          message: 'campaign id, appPlacementId (path) and campaignComponentId (body) must be numeric',
        });
      }

      // Validate target exists, belongs to (campaign, placement).
      const [target] = await db.select()
        .from(campaignComponents)
        .where(and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.id, targetRowId),
          eq(campaignComponents.appPlacementId, appPlacementId),
        ))
        .limit(1);
      if (!target) {
        return res.status(404).json({
          message: `Campaign component ${targetRowId} not found for placement ${appPlacementId} in campaign ${campaignId}`,
        });
      }

      const result = await db.transaction(async (tx) => {
        // Find the currently active row for this slot (if any). Excludes
        // the target itself in case it is already active (idempotency).
        const [currentActive] = await tx.select()
          .from(campaignComponents)
          .where(and(
            eq(campaignComponents.campaignId, campaignId),
            eq(campaignComponents.appPlacementId, appPlacementId),
            eq(campaignComponents.status, 'active'),
            ne(campaignComponents.id, targetRowId),
          ))
          .limit(1);

        // Idempotency: target already active and no other contender → no-op.
        if (target.status === 'active' && !currentActive) {
          return { row: target, eventEmitted: false, swap: false };
        }

        // 1) Deactivate the current active row (if any).
        if (currentActive) {
          await tx.update(campaignComponents)
            .set({ status: 'inactive', updatedAt: new Date() })
            .where(eq(campaignComponents.id, currentActive.id));
        }

        // 2) Activate the target.
        const [activated] = await tx.update(campaignComponents)
          .set({ status: 'active', activatedAt: new Date(), updatedAt: new Date() })
          .where(eq(campaignComponents.id, targetRowId))
          .returning();

        // 3) Enqueue the appropriate event. Swap → activation_swapped
        //    (one event, both ids); plain activation → status_changed.
        if (currentActive) {
          await enqueueEvent(tx, {
            topic: PLACEMENT_TOPICS.ACTIVATION_SWAPPED,
            module: 'placements',
            scopeType: 'campaign',
            scopeId: campaignId,
            payload: {
              campaignId,
              appPlacementId,
              fromCampaignComponentId: currentActive.id,
              toCampaignComponentId: activated.id,
              fromSponsorId: currentActive.sponsorId,
              toSponsorId: activated.sponsorId,
              newComponent: {
                id: activated.id,
                componentTypeId: null, // SDK reads this from cached app_placement
                sponsorId: activated.sponsorId,
                customConfig: activated.customConfig ?? null,
                status: activated.status,
              },
            },
          });
        } else {
          await enqueueEvent(tx, {
            topic: PLACEMENT_TOPICS.STATUS_CHANGED,
            module: 'placements',
            scopeType: 'campaign',
            scopeId: campaignId,
            payload: {
              campaignId,
              appPlacementId,
              campaignComponentId: activated.id,
              status: 'active',
            },
          });
        }

        return { row: activated, eventEmitted: true, swap: !!currentActive };
      });

      res.json({
        ...result.row,
        _meta: {
          eventEmitted: result.eventEmitted,
          swap: result.swap,
        },
      });
    } catch (error: any) {
      if (error?.code === '23505') {
        // Should be unreachable given the deactivate-first ordering,
        // but kept as a defense-in-depth signal.
        return res.status(409).json({
          code: 'PLACEMENT_ACTIVE_CONFLICT',
          message: 'Concurrent write race detected. Retry the request.',
        });
      }
      console.error('Error activating placement row:', error);
      res.status(500).json({ message: 'Error activating placement row' });
    }
  });

  // Validate component availability
  app.get('/api/components/:id/availability', async (req, res) => {
    try {
      const componentId = req.params.id;
      const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string) : undefined;

      // Verify component exists before checking availability
      const component = await storage.getComponentById(componentId);
      if (!component) {
        return res.status(404).json({ message: 'Component not found' });
      }

      const availability = await storage.validateComponentAvailability(componentId, component.isTemplate === 'true', campaignId);
      res.json(availability);
    } catch (error) {
      console.error('Error validating component availability:', error);
      res.status(500).json({ message: 'Error validating component availability' });
    }
  });

  // ========================================
  // Engagement SDK Endpoints (public, apiKey auth)
  // ========================================

  // SDK: Vote on a poll (public endpoint, uses apiKey)
  app.post('/v1/engagement/polls/:pollId/vote', createRateLimiter(rateLimitPresets.voting), validateBroadcastId, async (req, res) => {
    try {
      const pollId = parseInt(req.params.pollId);
      if (isNaN(pollId) || pollId <= 0) {
        return res.status(400).json({ message: 'Invalid pollId' });
      }

      if ((req as any).broadcastEnded) {
        return res.status(400).json({ message: 'Broadcast has ended, voting is closed' });
      }

      const parsed = voteInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors.map(e => e.message).join(', ') });
      }
      const { optionId, userId, broadcastId } = parsed.data;

      if (isQueueEnabled()) {
        await voteQueue.add('process-vote', { pollId, optionId, userId, broadcastId }, {
          jobId: `vote-${pollId}-${userId}`,
        });
        return res.json({ success: true, queued: true, message: 'Vote queued for processing' });
      }

      const { processPollVoteSync } = await import('./services/vote-processor');
      const result = await processPollVoteSync({ pollId, optionId, userId, broadcastId });

      if (!result.success) {
        const statusCode = result.error?.includes('not found') ? 404 :
          result.error?.includes('already voted') ? 409 :
            result.error?.includes('not active') ? 400 : 500;
        return res.status(statusCode).json({ message: result.error });
      }

      if (result.data) {
        const totalVotes = result.data.poll.totalVotes;
        const optionsWithPercentages = result.data.options.map((opt: any) => ({
          ...opt,
          percentage: totalVotes > 0 ? Math.round((opt.voteCount / totalVotes) * 10000) / 100 : 0
        }));
        res.json({ success: true, results: { ...result.data.poll, options: optionsWithPercentages } });
      } else {
        res.json({ success: true });
      }
    } catch (error: any) {
      if (error.code === '23505') {
        return res.status(409).json({ message: 'User has already voted on this poll' });
      }
      console.error('Error voting on poll:', error);
      res.status(500).json({ message: 'Error voting on poll' });
    }
  });

  // SDK: Get polls for a broadcast (public)
  app.get('/v1/engagement/polls', async (req, res) => {
    try {
      const broadcastId = req.query.broadcastId as string;
      if (!broadcastId) {
        return res.status(400).json({ message: 'broadcastId query parameter is required' });
      }

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) {
        return res.status(404).json({ message: 'Broadcast not found', broadcastId });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const currentVideoTime = req.query.currentVideoTime ? parseInt(req.query.currentVideoTime as string) : undefined;

      const pollsList = await storage.getBroadcastPollsPaginated(broadcastId, { limit, offset });
      let filteredPolls = pollsList.filter(poll => poll.isActive);

      if (currentVideoTime !== undefined && !isNaN(currentVideoTime)) {
        filteredPolls = filteredPolls.filter(poll => {
          if (poll.videoStartTime === null && poll.videoEndTime === null) return true;
          const start = poll.videoStartTime ?? 0;
          const end = poll.videoEndTime ?? Infinity;
          return currentVideoTime >= start && currentVideoTime <= end;
        });
      }

      const pollsWithPercentages = filteredPolls.map(poll => {
        const totalVotes = poll.totalVotes;
        const options = poll.options.map(opt => ({
          ...opt,
          percentage: totalVotes > 0 ? Math.round((opt.voteCount / totalVotes) * 10000) / 100 : 0
        }));
        return { ...poll, options };
      });

      const total = await storage.getBroadcastPollsCount(broadcastId);
      res.json({
        polls: pollsWithPercentages,
        pagination: { limit, offset, total, hasMore: offset + limit < total }
      });
    } catch (error) {
      console.error('Error getting polls:', error);
      res.status(500).json({ message: 'Error getting polls' });
    }
  });

  // SDK: Participate in a contest (public)
  app.post('/v1/engagement/contests/:contestId/participate', createRateLimiter(rateLimitPresets.participation), validateBroadcastId, async (req, res) => {
    try {
      const contestId = parseInt(req.params.contestId);
      if (isNaN(contestId) || contestId <= 0) {
        return res.status(400).json({ message: 'Invalid contestId' });
      }

      if ((req as any).broadcastEnded) {
        return res.status(400).json({ message: 'Broadcast has ended, participation is closed' });
      }

      const parsed = participateInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors.map(e => e.message).join(', ') });
      }
      const { userId, broadcastId, answers } = parsed.data;

      if (isQueueEnabled()) {
        await contestParticipationQueue.add('process-participation', { contestId, userId, broadcastId, answers }, {
          jobId: `participate-${contestId}-${userId}`,
        });
        return res.status(201).json({ success: true, queued: true, message: 'Participation queued for processing' });
      }

      const { processContestParticipationSync } = await import('./services/contest-processor');
      const result = await processContestParticipationSync({ contestId, userId, broadcastId, answers });

      if (!result.success) {
        const statusCode = result.error?.includes('not found') ? 404 :
          result.error?.includes('already participated') ? 409 :
            result.error?.includes('not active') ? 400 : 500;
        return res.status(statusCode).json({ message: result.error });
      }

      res.status(201).json(result.data);
    } catch (error: any) {
      if (error.code === '23505') {
        return res.status(409).json({ message: 'User has already participated in this contest' });
      }
      console.error('Error participating in contest:', error);
      res.status(500).json({ message: 'Error participating in contest' });
    }
  });

  // SDK: Get contests for a broadcast (public)
  app.get('/v1/engagement/contests', async (req, res) => {
    try {
      const broadcastId = req.query.broadcastId as string;
      if (!broadcastId) {
        return res.status(400).json({ message: 'broadcastId query parameter is required' });
      }

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) {
        return res.status(404).json({ message: 'Broadcast not found', broadcastId });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const currentVideoTime = req.query.currentVideoTime ? parseInt(req.query.currentVideoTime as string) : undefined;

      const contestsList = await storage.getBroadcastContestsPaginated(broadcastId, { limit, offset });
      let filteredContests = contestsList.filter(contest => contest.isActive);

      if (currentVideoTime !== undefined && !isNaN(currentVideoTime)) {
        filteredContests = filteredContests.filter(contest => {
          if (contest.videoStartTime === null && contest.videoEndTime === null) return true;
          const start = contest.videoStartTime ?? 0;
          const end = contest.videoEndTime ?? Infinity;
          return currentVideoTime >= start && currentVideoTime <= end;
        });
      }

      const total = await storage.getBroadcastContestsCount(broadcastId);
      res.json({
        contests: filteredContests,
        pagination: { limit, offset, total, hasMore: offset + limit < total }
      });
    } catch (error) {
      console.error('Error getting contests:', error);
      res.status(500).json({ message: 'Error getting contests' });
    }
  });

  // Also expose broadcasts listing without auth for dashboard internal API
  app.get('/api/broadcasts', async (req, res) => {
    try {
      const { status, campaignId } = req.query;
      const filters: { status?: string; campaignId?: number } = {};
      if (status) filters.status = status as string;
      if (campaignId) filters.campaignId = parseInt(campaignId as string);
      let broadcastsList = await storage.getAllBroadcasts(filters);

      // Tenant-scope the list (ADR-0008): a broadcast belongs to a tenant via
      // its campaign's owner. super_admin (owner === null) sees all.
      const owner = readScopeOwnerId(req.operator);
      if (owner !== null) {
        const myCampaignIds = new Set((await storage.getUserCampaigns(owner)).map(c => c.id));
        broadcastsList = broadcastsList.filter(b => b.campaignId !== null && myCampaignIds.has(b.campaignId));
      }

      const broadcastIds = broadcastsList.map(b => b.broadcastId);
      const engagementCounts = await storage.getBroadcastEngagementCounts(broadcastIds);

      const campaignIds = [...new Set(broadcastsList.map(b => b.campaignId).filter((id): id is number => id !== null))];
      const campaignInfo = new Map<number, { name: string; clientAppName: string | null }>();
      for (const cId of campaignIds) {
        const c = await storage.getCampaign(cId);
        if (c) {
          let clientAppName: string | null = null;
          if (c.clientAppId) {
            const app = await storage.getClientApp(c.clientAppId);
            if (app) clientAppName = app.name;
          }
          campaignInfo.set(cId, { name: c.name, clientAppName });
        }
      }

      const enriched = broadcastsList.map(b => {
        const counts = engagementCounts.get(b.broadcastId);
        const info = b.campaignId ? campaignInfo.get(b.campaignId) : null;
        return {
          ...b,
          pollCount: counts?.pollCount ?? 0,
          activePollCount: counts?.activePollCount ?? 0,
          contestCount: counts?.contestCount ?? 0,
          campaignName: info?.name ?? null,
          clientAppName: info?.clientAppName ?? null,
        };
      });

      res.json(enriched);
    } catch (error) {
      console.error('Error listing broadcasts:', error);
      res.status(500).json({ message: 'Error listing broadcasts' });
    }
  });

  app.get('/api/broadcasts/:broadcastId', async (req, res) => {
    try {
      const broadcast = await storage.getBroadcast(req.params.broadcastId);
      if (!broadcast) {
        return res.status(404).json({ message: 'Broadcast not found' });
      }
      const pollsList = await storage.getBroadcastPolls(broadcast.broadcastId);
      const contestsList = await storage.getBroadcastContests(broadcast.broadcastId);
      res.json({ ...broadcast, polls: pollsList, contests: contestsList });
    } catch (error) {
      console.error('Error getting broadcast:', error);
      res.status(500).json({ message: 'Error getting broadcast' });
    }
  });

  app.post('/api/broadcasts', async (req, res) => {
    try {
      const { broadcastName, externalId, description, campaignId, channelId, startTime, endTime, metadata, createdBy,
        sportmonksFixtureId, homeTeamName, homeTeamLogo, awayTeamName, awayTeamLogo, matchStartingAt, leagueName } = req.body;

      if (!broadcastName) {
        return res.status(400).json({ message: 'broadcastName is required' });
      }

      const dateStr = startTime ? new Date(startTime).toISOString().split('T')[0] : undefined;
      let broadcastId = generateBroadcastId(broadcastName, dateStr);

      const existing = await storage.getBroadcast(broadcastId);
      if (existing) {
        broadcastId = `${broadcastId}-${Date.now()}`;
      }

      const broadcast = await storage.createBroadcast({
        broadcastId,
        broadcastName,
        externalId: externalId || null,
        description: description || null,
        campaignId: campaignId || null,
        channelId: channelId || null,
        startTime: startTime ? new Date(startTime) : null,
        endTime: endTime ? new Date(endTime) : null,
        status: 'upcoming',
        metadata: metadata || null,
        createdBy: createdBy || null,
        sportmonksFixtureId: sportmonksFixtureId || null,
        homeTeamName: homeTeamName || null,
        homeTeamLogo: homeTeamLogo || null,
        awayTeamName: awayTeamName || null,
        awayTeamLogo: awayTeamLogo || null,
        matchStartingAt: matchStartingAt ? new Date(matchStartingAt) : null,
        leagueName: leagueName || null,
      });

      res.status(201).json(broadcast);
    } catch (error) {
      console.error('Error creating broadcast:', error);
      res.status(500).json({ message: 'Error creating broadcast' });
    }
  });

  app.put('/api/broadcasts/:broadcastId', async (req, res) => {
    try {
      const { broadcastName, externalId, description, campaignId, channelId, startTime, endTime, status, metadata,
        sportmonksFixtureId, homeTeamName, homeTeamLogo, awayTeamName, awayTeamLogo, matchStartingAt, leagueName,
        showLineup } = req.body;
      const existing = await storage.getBroadcast(req.params.broadcastId);
      if (!existing) return res.status(404).json({ message: 'Broadcast not found' });

      const updateData: any = {};
      if (broadcastName !== undefined) updateData.broadcastName = broadcastName;
      if (externalId !== undefined) updateData.externalId = externalId || null;
      if (description !== undefined) updateData.description = description;
      if (campaignId !== undefined) updateData.campaignId = campaignId;
      if (channelId !== undefined) updateData.channelId = channelId;
      if (startTime !== undefined) updateData.startTime = startTime ? new Date(startTime) : null;
      if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;
      if (status !== undefined) updateData.status = status;
      if (metadata !== undefined) updateData.metadata = metadata;
      if (sportmonksFixtureId !== undefined) updateData.sportmonksFixtureId = sportmonksFixtureId || null;
      if (homeTeamName !== undefined) updateData.homeTeamName = homeTeamName || null;
      if (homeTeamLogo !== undefined) updateData.homeTeamLogo = homeTeamLogo || null;
      if (awayTeamName !== undefined) updateData.awayTeamName = awayTeamName || null;
      if (awayTeamLogo !== undefined) updateData.awayTeamLogo = awayTeamLogo || null;
      if (matchStartingAt !== undefined) updateData.matchStartingAt = matchStartingAt ? new Date(matchStartingAt) : null;
      if (leagueName !== undefined) updateData.leagueName = leagueName || null;
      if (showLineup !== undefined) updateData.showLineup = showLineup;

      // Auto-set startedAt when broadcast goes live for the first time
      if (status === 'live' && existing.status !== 'live' && !existing.startedAt) {
        updateData.startedAt = new Date();
      }

      const updated = await storage.updateBroadcast(req.params.broadcastId, updateData);
      if (!updated) return res.status(404).json({ message: 'Broadcast not found' });

      if (status !== undefined && status !== existing.status && updated.campaignId) {
        if (status === 'live') {
          broadcastToCampaign(updated.campaignId, JSON.stringify({
            type: 'broadcast_started',
            broadcastId: updated.broadcastId,
            broadcastName: updated.broadcastName,
            campaignId: updated.campaignId,
            timestamp: new Date().toISOString()
          }));
        } else if (status === 'ended') {
          broadcastToCampaign(updated.campaignId, JSON.stringify({
            type: 'broadcast_ended',
            broadcastId: updated.broadcastId,
            broadcastName: updated.broadcastName,
            campaignId: updated.campaignId,
            timestamp: new Date().toISOString()
          }));
        }
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating broadcast:', error);
      res.status(500).json({ message: 'Error updating broadcast' });
    }
  });

  app.delete('/api/broadcasts/:broadcastId', async (req, res) => {
    try {
      const broadcast = await storage.getBroadcast(req.params.broadcastId);
      if (!broadcast) {
        return res.status(404).json({ message: 'Broadcast not found' });
      }
      await storage.deleteBroadcast(req.params.broadcastId);
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting broadcast:', error);
      res.status(500).json({ message: 'Error deleting broadcast' });
    }
  });

  app.get('/api/broadcasts/:broadcastId/polls', async (req, res) => {
    try {
      const pollsList = await storage.getBroadcastPolls(req.params.broadcastId);
      res.json(pollsList);
    } catch (error) {
      console.error('Error getting polls:', error);
      res.status(500).json({ message: 'Error getting polls' });
    }
  });

  app.post('/api/broadcasts/:broadcastId/polls', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) {
        return res.status(404).json({ message: 'Broadcast not found' });
      }

      const { question, options, duration, startTime, endTime, isActive, videoStartTime, videoEndTime, broadcastStartTime } = req.body;
      if (!question || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ message: 'question and at least 2 options are required' });
      }

      const pollData: any = {
        broadcastId,
        question,
        duration: duration ?? null,
        startTime: startTime ? new Date(startTime) : null,
        endTime: endTime ? new Date(endTime) : null,
        isActive: isActive !== undefined ? isActive : true
      };

      if (videoStartTime !== undefined) pollData.videoStartTime = videoStartTime;
      if (videoEndTime !== undefined) pollData.videoEndTime = videoEndTime;

      if (videoStartTime !== undefined && videoEndTime !== undefined && broadcastStartTime) {
        const validation = validateScheduling({ broadcastStartTime, videoStartTime, videoEndTime });
        if (!validation.valid) {
          return res.status(400).json({ message: validation.error });
        }
        const scheduled = calculateScheduledTimes({ broadcastStartTime, videoStartTime, videoEndTime });
        pollData.broadcastStartTime = new Date(broadcastStartTime);
        pollData.scheduledStartTime = scheduled.scheduledStart;
        pollData.scheduledEndTime = scheduled.scheduledEnd;
      }

      const poll = await storage.createPoll(pollData);

      const createdOptions = [];
      for (let i = 0; i < options.length; i++) {
        const optionText = typeof options[i] === 'string' ? options[i] : options[i].text;
        const option = await storage.createPollOption({
          pollId: poll.id,
          text: optionText,
          displayOrder: i
        });
        createdOptions.push(option);
      }

      res.status(201).json({ ...poll, options: createdOptions });
    } catch (error) {
      console.error('Error creating poll:', error);
      res.status(500).json({ message: 'Error creating poll' });
    }
  });

  app.put('/api/polls/:pollId', async (req, res) => {
    try {
      const pollId = parseInt(req.params.pollId);
      const { question, isActive, duration, startTime, endTime, videoStartTime, videoEndTime } = req.body;
      const updateData: any = {};
      if (question !== undefined) updateData.question = question;
      if (isActive !== undefined) updateData.isActive = isActive;
      if (duration !== undefined) updateData.duration = duration ?? null;
      if (startTime !== undefined) updateData.startTime = startTime ? new Date(startTime) : null;
      if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;
      if (videoStartTime !== undefined) updateData.videoStartTime = videoStartTime;
      if (videoEndTime !== undefined) updateData.videoEndTime = videoEndTime;

      const updated = await storage.updatePoll(pollId, updateData);
      if (!updated) {
        return res.status(404).json({ message: 'Poll not found' });
      }
      res.json(updated);
    } catch (error) {
      console.error('Error updating poll:', error);
      res.status(500).json({ message: 'Error updating poll' });
    }
  });

  app.delete('/api/polls/:pollId', async (req, res) => {
    try {
      const pollId = parseInt(req.params.pollId);
      await storage.deletePoll(pollId);
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting poll:', error);
      res.status(500).json({ message: 'Error deleting poll' });
    }
  });

  app.get('/api/broadcasts/:broadcastId/contests', async (req, res) => {
    try {
      const contestsList = await storage.getBroadcastContests(req.params.broadcastId);
      res.json(contestsList);
    } catch (error) {
      console.error('Error getting contests:', error);
      res.status(500).json({ message: 'Error getting contests' });
    }
  });

  app.post('/api/broadcasts/:broadcastId/contests', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) {
        return res.status(404).json({ message: 'Broadcast not found' });
      }

      const { title, description, prize, contestType, startTime, endTime, isActive, imageUrl, videoStartTime, videoEndTime, broadcastStartTime } = req.body;
      if (!title || !contestType) {
        return res.status(400).json({ message: 'title and contestType are required' });
      }

      const contestIsActive = isActive !== undefined ? isActive : true;
      const contestData: any = {
        broadcastId,
        title,
        description: description || null,
        prize: prize || null,
        contestType,
        imageUrl: imageUrl || null,
        startTime: startTime ? new Date(startTime) : null,
        endTime: endTime ? new Date(endTime) : null,
        isActive: contestIsActive
      };

      if (videoStartTime !== undefined) contestData.videoStartTime = videoStartTime;
      if (videoEndTime !== undefined) contestData.videoEndTime = videoEndTime;

      if (videoStartTime !== undefined && videoEndTime !== undefined && broadcastStartTime) {
        const validation = validateScheduling({ broadcastStartTime, videoStartTime, videoEndTime });
        if (!validation.valid) {
          return res.status(400).json({ message: validation.error });
        }
        const scheduled = calculateScheduledTimes({ broadcastStartTime, videoStartTime, videoEndTime });
        contestData.broadcastStartTime = new Date(broadcastStartTime);
        contestData.scheduledStartTime = scheduled.scheduledStart;
        contestData.scheduledEndTime = scheduled.scheduledEnd;
      }

      const contest = await storage.createContest(contestData);

      if (contestIsActive && broadcast.campaignId) {
        const wsEvent = {
          type: 'contest',
          broadcastId,
          id: String(contest.id),
          title: contest.title,
          description: contest.description || '',
          prize: contest.prize || '',
          contestType: contest.contestType,
          imageUrl: contest.imageUrl ? normalizeUrls(contest.imageUrl, req.protocol, req.get('host')) : null,
          isActive: true,
          timestamp: Date.now()
        };
        broadcastToCampaignImpl(broadcast.campaignId, JSON.stringify(wsEvent));
      }

      res.status(201).json(contest);
    } catch (error) {
      console.error('Error creating contest:', error);
      res.status(500).json({ message: 'Error creating contest' });
    }
  });

  app.put('/api/contests/:contestId', async (req, res) => {
    try {
      const contestId = parseInt(req.params.contestId);
      const { title, description, prize, contestType, isActive, imageUrl, startTime, endTime, videoStartTime, videoEndTime } = req.body;
      const updateData: any = {};
      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (prize !== undefined) updateData.prize = prize;
      if (contestType !== undefined) updateData.contestType = contestType;
      if (isActive !== undefined) updateData.isActive = isActive;
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl || null;
      if (startTime !== undefined) updateData.startTime = startTime ? new Date(startTime) : null;
      if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;
      if (videoStartTime !== undefined) updateData.videoStartTime = videoStartTime;
      if (videoEndTime !== undefined) updateData.videoEndTime = videoEndTime;

      const updated = await storage.updateContest(contestId, updateData);
      if (!updated) {
        return res.status(404).json({ message: 'Contest not found' });
      }

      // Emit WS event when activating a contest
      if (isActive === true) {
        const broadcast = await storage.getBroadcast(updated.broadcastId);
        if (broadcast?.campaignId) {
          const wsEvent = {
            type: 'contest',
            broadcastId: updated.broadcastId,
            id: String(updated.id),
            title: updated.title,
            description: updated.description || '',
            prize: updated.prize || '',
            contestType: updated.contestType,
            imageUrl: updated.imageUrl ? normalizeUrls(updated.imageUrl, req.protocol, req.get('host')) : null,
            isActive: true,
            timestamp: Date.now()
          };
          broadcastToCampaignImpl(broadcast.campaignId, JSON.stringify(wsEvent));
        }
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating contest:', error);
      res.status(500).json({ message: 'Error updating contest' });
    }
  });

  app.delete('/api/contests/:contestId', async (req, res) => {
    try {
      const contestId = parseInt(req.params.contestId);
      await storage.deleteContest(contestId);
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting contest:', error);
      res.status(500).json({ message: 'Error deleting contest' });
    }
  });

  // ========================================
  // Broadcast Ads Endpoints
  // ========================================
  app.get('/api/broadcasts/:broadcastId/ads', async (req, res) => {
    try {
      const ads = await storage.getBroadcastAds(req.params.broadcastId);
      res.json(ads);
    } catch (error) {
      res.status(500).json({ message: 'Error getting ads' });
    }
  });

  app.post('/api/broadcasts/:broadcastId/ads', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });
      const ad = await storage.createBroadcastAd({ ...req.body, broadcastId });
      res.status(201).json(ad);
    } catch (error) {
      res.status(500).json({ message: 'Error creating ad' });
    }
  });

  app.put('/api/broadcasts/ads/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updated = await storage.updateBroadcastAd(id, req.body);
      if (!updated) return res.status(404).json({ message: 'Ad not found' });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: 'Error updating ad' });
    }
  });

  app.delete('/api/broadcasts/ads/:id', async (req, res) => {
    try {
      await storage.deleteBroadcastAd(parseInt(req.params.id));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: 'Error deleting ad' });
    }
  });

  // ========================================
  // Broadcast Products Endpoints
  // ========================================
  app.get('/api/broadcasts/:broadcastId/products', async (req, res) => {
    try {
      const products = await storage.getBroadcastProducts(req.params.broadcastId);
      res.json(products);
    } catch (error) {
      res.status(500).json({ message: 'Error getting products' });
    }
  });

  app.post('/api/broadcasts/:broadcastId/products', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });
      const product = await storage.createBroadcastProduct({ ...req.body, broadcastId });
      res.status(201).json(product);
    } catch (error) {
      res.status(500).json({ message: 'Error creating product' });
    }
  });

  app.put('/api/broadcasts/products/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updated = await storage.updateBroadcastProduct(id, req.body);
      if (!updated) return res.status(404).json({ message: 'Product not found' });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: 'Error updating product' });
    }
  });

  app.delete('/api/broadcasts/products/:id', async (req, res) => {
    try {
      await storage.deleteBroadcastProduct(parseInt(req.params.id));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: 'Error deleting product' });
    }
  });

  // ========================================
  // Chat Messages Endpoints
  // ========================================
  app.get('/api/broadcasts/:broadcastId/chat', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const messages = await storage.getChatMessages(req.params.broadcastId, limit);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ message: 'Error getting chat messages' });
    }
  });

  app.post('/api/broadcasts/:broadcastId/chat', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const { username, message } = req.body;
      if (!username || !message) return res.status(400).json({ message: 'username and message are required' });
      const chatMsg = await storage.createChatMessage({ broadcastId, username, message, type: 'message' });
      // Emit WebSocket event to all SDK clients on this broadcast's campaign
      const broadcast = await storage.getBroadcast(broadcastId);
      if (broadcast?.campaignId) {
        broadcastToCampaign(broadcast.campaignId, JSON.stringify({
          type: 'chat_message',
          data: { id: chatMsg.id, broadcastId, username, message, type: 'message', createdAt: chatMsg.createdAt }
        }));
      }
      res.status(201).json(chatMsg);
    } catch (error) {
      res.status(500).json({ message: 'Error creating chat message' });
    }
  });

  // DELETE /api/chat/:id — Remove a single chat message
  app.delete('/api/chat/:id', async (req, res) => {
    try {
      await storage.deleteChatMessage(parseInt(req.params.id));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: 'Error deleting chat message' });
    }
  });

  // ========================================
  // Tweet Endpoint (T2)
  // ========================================
  app.post('/api/broadcasts/:broadcastId/tweet', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const { username, message, tweetId, via, metrics } = req.body;
      if (!username || !message) return res.status(400).json({ message: 'username and message are required' });
      const metadata = tweetId ? { tweetId, via: via || null, metrics: metrics || null } : null;
      const chatMsg = await storage.createChatMessage({ broadcastId, username, message, type: 'tweet', metadata });
      const broadcast = await storage.getBroadcast(broadcastId);
      if (broadcast?.campaignId) {
        broadcastToCampaign(broadcast.campaignId, JSON.stringify({
          type: 'tweet',
          data: { id: chatMsg.id, broadcastId, username, message, type: 'tweet', metadata, createdAt: chatMsg.createdAt }
        }));
      }
      res.status(201).json(chatMsg);
    } catch (error) {
      res.status(500).json({ message: 'Error creating tweet' });
    }
  });

  // ========================================
  // Match Data Endpoint (T3)
  // ========================================
  app.put('/api/broadcasts/:broadcastId/match-data', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });
      const { homeTeam, awayTeam, minute, matchStatus, stats } = req.body;
      const matchData = { homeTeam, awayTeam, minute: minute ?? null, matchStatus: matchStatus || 'NS', stats: stats || null };
      const existingMetadata = (broadcast.metadata as any) || {};
      const updated = await storage.updateBroadcast(broadcastId, {
        metadata: { ...existingMetadata, matchData }
      });
      if (broadcast.campaignId) {
        broadcastToCampaign(broadcast.campaignId, JSON.stringify({
          type: 'score_update',
          data: { broadcastId, ...matchData }
        }));
      }
      res.json({ broadcastId, matchData, metadata: updated?.metadata });
    } catch (error) {
      res.status(500).json({ message: 'Error updating match data' });
    }
  });

  // ========================================
  // Sportmonks Integration Endpoints
  // ========================================

  const SPORTMONKS_BASE = 'https://api.sportmonks.com/v3/football';
  const SPORTMONKS_TOKEN = process.env.SPORTMONKS_API_TOKEN || '';
  const FIXTURE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;       // 6 hours — fixtures change frequently
  const LEAGUE_CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000;  // 2 days  — leagues are stable

  const sportmonksFetch = async (path: string) => {
    const url = `${SPORTMONKS_BASE}${path}`;
    const res = await fetch(url, { headers: { Authorization: SPORTMONKS_TOKEN } });
    if (!res.ok) throw new Error(`Sportmonks ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const isCacheValidFor = (cache: { updatedAt: Date | string } | undefined, ttlMs: number) => {
    if (!cache) return false;
    return Date.now() - new Date(cache.updatedAt).getTime() < ttlMs;
  };

  // GET /api/sportmonks/leagues
  app.get('/api/sportmonks/leagues', async (req, res) => {
    try {
      const cached = await storage.getSportmonksCache('leagues');
      if (isCacheValidFor(cached, LEAGUE_CACHE_TTL_MS)) {
        return res.json(cached!.data);
      }
      const json = await sportmonksFetch('/leagues?per_page=150&include=country');
      const leagues = (json.data || []).map((l: any) => ({
        id: l.id,
        name: l.name,
        shortCode: l.short_code || null,
        logoUrl: l.image_path || null,
        countryName: l.country?.name || null,
      }));
      await storage.upsertSportmonksCache('leagues', leagues);
      res.json(leagues);
    } catch (error: any) {
      console.error('Sportmonks leagues error:', error.message);
      res.status(502).json({ message: 'Failed to fetch leagues from Sportmonks', error: error.message });
    }
  });

  // GET /api/sportmonks/fixtures?leagueId=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
  app.get('/api/sportmonks/fixtures', async (req, res) => {
    try {
      const leagueId = parseInt(req.query.leagueId as string);
      const dateFrom = req.query.dateFrom as string;
      const dateTo = req.query.dateTo as string;

      if (!leagueId || !dateFrom || !dateTo) {
        return res.status(400).json({ message: 'leagueId, dateFrom, and dateTo are required' });
      }

      // Cache check — serves pre-filtered clean data (6h TTL)
      const cached = await storage.getSportmonksCache('fixtures', leagueId, dateFrom, dateTo);
      if (isCacheValidFor(cached, FIXTURE_CACHE_TTL_MS)) {
        return res.json(cached!.data);
      }

      // Sportmonks ?leagues= param does NOT filter correctly — fetch all and filter server-side
      const path = `/fixtures/between/${dateFrom}/${dateTo}?per_page=150&include=participants`;
      const json = await sportmonksFetch(path);

      // Strict server-side filter: only fixtures belonging to the requested league
      const fixtures = (json.data || [])
        .filter((f: any) => f.league_id === leagueId)
        .map((f: any) => {
          const participants = f.participants || [];
          const home = participants.find((p: any) => p.meta?.location === 'home');
          const away = participants.find((p: any) => p.meta?.location === 'away');
          return {
            id: f.id,
            name: f.name,
            startingAt: f.starting_at,
            leagueId: f.league_id,
            status: f.result_info || f.state?.name || null,
            homeTeam: home ? { id: home.id, name: home.name, logoUrl: home.image_path || null } : null,
            awayTeam: away ? { id: away.id, name: away.name, logoUrl: away.image_path || null } : null,
          };
        });

      // Cache only the already-filtered clean data
      await storage.upsertSportmonksCache('fixtures', fixtures, leagueId, dateFrom, dateTo);
      res.json(fixtures);
    } catch (error: any) {
      console.error('Sportmonks fixtures error:', error.message);
      res.status(502).json({ message: 'Failed to fetch fixtures from Sportmonks', error: error.message });
    }
  });

  // GET /api/sportmonks/fixture/:id/result — Full fixture result with events
  // Cache: 5min for finished, 30s for live
  const fixtureResultCache: Map<number, { data: any; fetchedAt: number; status: string }> = new Map();

  app.get('/api/sportmonks/fixture/:fixtureId/result', async (req, res) => {
    try {
      const fixtureId = parseInt(req.params.fixtureId);
      if (!fixtureId) return res.status(400).json({ message: 'Invalid fixtureId' });

      const cached = fixtureResultCache.get(fixtureId);
      const ttl = cached?.status === 'FT' || cached?.status === 'AET' ? 5 * 60 * 1000 : 30 * 1000;
      if (cached && Date.now() - cached.fetchedAt < ttl) {
        return res.json(cached.data);
      }

      const json = await sportmonksFetch(`/fixtures/${fixtureId}?include=events.type;participants;scores`);
      const f = json.data;
      if (!f) return res.status(404).json({ message: 'Fixture not found' });

      const participants = f.participants || [];
      const home = participants.find((p: any) => p.meta?.location === 'home');
      const away = participants.find((p: any) => p.meta?.location === 'away');

      const scores = f.scores || [];
      const getCurrentScore = (teamId: number) => {
        const current = scores.filter((s: any) => s.participant_id === teamId && s.description === 'CURRENT');
        if (current.length > 0) return current[current.length - 1]?.score?.goals ?? 0;
        const ft = scores.filter((s: any) => s.participant_id === teamId && (s.description === 'FT' || s.description === '2ND_HALF'));
        if (ft.length > 0) return ft[ft.length - 1]?.score?.goals ?? 0;
        return 0;
      };

      const typeMap: Record<string, string> = {
        'GOAL': 'goal', 'OWNGOAL': 'owngoal', 'YELLOWCARD': 'yellowcard',
        'REDCARD': 'redcard', 'SUBSTITUTION': 'substitution', 'VAR': 'var',
        'PENALTY': 'penalty', 'PENALTY_SHOOTOUT': 'penalty',
      };

      const keyEventTypes = new Set(['kickoff', 'goal', 'owngoal', 'yellowcard', 'redcard', 'halftime', 'fulltime', 'var', 'penalty']);

      const rawEvents = (f.events || []).map((e: any) => {
        const typeName = e.type?.developer_name?.toUpperCase() || e.type?.name?.toUpperCase() || '';
        const mapped = typeMap[typeName] || typeName.toLowerCase();
        return {
          minute: e.minute || 0,
          type: mapped,
          label: e.player_name || e.detail || mapped,
          teamId: e.participant_id || null,
          score: null as string | null,
        };
      });

      // Add kickoff and fulltime synthetic events
      const allEvents = [
        { minute: 0, type: 'kickoff', label: 'Avspark', teamId: null, score: null },
        ...rawEvents,
      ];

      // Determine full time status
      // Sportmonks state_id: 5=FT, 3=HT, 2=1H(live), 4=2H(live), 1=NS, 6+=AET/penalties
      const numericStateId: number | null = f.state_id ?? null;
      const numericStateMap: Record<number, string> = {
        1: 'NS', 2: 'LIVE', 3: 'HT', 4: 'LIVE', 5: 'FT',
        6: 'FT', 7: 'FT', 8: 'FT', 9: 'FT',
      };
      const stateId = f.state?.state || f.state?.developer_name || '';
      const statusMap: Record<string, string> = {
        'FT': 'FT', 'FINISHED': 'FT', 'FULL_TIME': 'FT',
        'HT': 'HT', 'HALF_TIME': 'HT',
        'LIVE': 'LIVE', 'INPLAY': 'LIVE',
        'NS': 'NS', 'NOT_STARTED': 'NS',
      };
      let status = numericStateId != null
        ? (numericStateMap[numericStateId] || 'NS')
        : (statusMap[stateId.toUpperCase()] || stateId || 'NS');
      // Fallback: if date is >3h ago and events exist => treat as FT
      if (status === 'NS' && rawEvents.length > 0) status = 'FT';
      if (status === 'NS' && f.starting_at && new Date(f.starting_at) < new Date(Date.now() - 3 * 60 * 60 * 1000)) status = 'FT';

      if (status === 'FT' || status === 'AET') {
        allEvents.push({ minute: 90, type: 'fulltime', label: 'Fulltid', teamId: null, score: null });
      }

      const filteredEvents = allEvents
        .filter(e => keyEventTypes.has(e.type))
        .sort((a, b) => a.minute - b.minute);

      const result = {
        fixtureId,
        homeTeam: home ? { id: home.id, name: home.name, logo: home.image_path || null } : null,
        awayTeam: away ? { id: away.id, name: away.name, logo: away.image_path || null } : null,
        homeScore: home ? getCurrentScore(home.id) : 0,
        awayScore: away ? getCurrentScore(away.id) : 0,
        status,
        date: f.starting_at ? f.starting_at.substring(0, 10) : null,
        league: f.league?.name || null,
        events: filteredEvents,
      };

      if (fixtureResultCache.size > 200) {
        fixtureResultCache.delete(fixtureResultCache.keys().next().value!);
      }
      fixtureResultCache.set(fixtureId, { data: result, fetchedAt: Date.now(), status });
      res.json(result);
    } catch (error: any) {
      console.error('Sportmonks fixture result error:', error.message);
      res.status(502).json({ message: 'Failed to fetch fixture result', error: error.message });
    }
  });

  // ========================================
  // Lineup Endpoints (Sportmonks)
  // ========================================

  const LINEUP_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — lineups can change until ~15min before kickoff

  function mapPosition(positionId: number): string {
    switch (positionId) {
      case 24: return "goalkeeper";
      case 25: return "defender";
      case 26: return "midfielder";
      case 27: return "forward";
      default: return "forward";
    }
  }

  function deriveFormation(players: { position: string }[]): string | null {
    const def = players.filter(p => p.position === 'defender').length;
    const mid = players.filter(p => p.position === 'midfielder').length;
    const fwd = players.filter(p => p.position === 'forward').length;
    if (def === 0 && mid === 0 && fwd === 0) return null;
    return `${def}-${mid}-${fwd}`;
  }

  // In-flight dedup: prevents N simultaneous cache-miss requests hitting Sportmonks in parallel
  const lineupInFlight = new Map<string, Promise<any>>();

  async function fetchLineupData(fixtureId: number, homeTeamId: number | undefined, awayTeamId: number | undefined, broadcast: any): Promise<any> {
    const cacheKey = `lineup_${fixtureId}`;
    const cached = await storage.getSportmonksCache(cacheKey);
    if (isCacheValidFor(cached, LINEUP_CACHE_TTL_MS)) return cached!.data;

    if (lineupInFlight.has(cacheKey)) return lineupInFlight.get(cacheKey)!;

    const promise = (async () => {
      try {
        // Bug 1 fix: use sportmonksFetch (consistent token handling + proper error throwing)
        const json = await sportmonksFetch(`/fixtures/${fixtureId}?include=lineups.player`);
        const lineups: any[] = (json.data?.lineups || []).filter((l: any) => l.type_id === 11);

        if (lineups.length === 0) {
          const result = { available: false, message: 'Lineup not yet available' };
          await storage.upsertSportmonksCache(cacheKey, result);
          return result;
        }

        const mapPlayer = (l: any) => ({
          id: l.player_id,
          name: l.player?.name || l.player?.display_name || `#${l.player_id}`,
          jerseyNumber: l.jersey_number ?? null,
          position: mapPosition(l.position_id ?? 0),
        });

        let homePlayers = lineups.filter((l: any) => l.team_id === homeTeamId).map(mapPlayer);
        let awayPlayers = lineups.filter((l: any) => l.team_id === awayTeamId).map(mapPlayer);

        if (homePlayers.length === 0 && awayPlayers.length === 0) {
          const teamIds = [...new Set(lineups.map((l: any) => l.team_id))];
          homePlayers = lineups.filter((l: any) => l.team_id === teamIds[0]).map(mapPlayer);
          awayPlayers = lineups.filter((l: any) => l.team_id === teamIds[1]).map(mapPlayer);
        }

        const result = {
          fixtureId,
          available: true,
          home: {
            teamId: homeTeamId ?? null,
            teamName: broadcast.homeTeamName ?? null,
            teamLogo: broadcast.homeTeamLogo ?? null,
            formation: deriveFormation(homePlayers.filter((p: any) => p.position !== 'goalkeeper')),
            players: homePlayers,
          },
          away: {
            teamId: awayTeamId ?? null,
            teamName: broadcast.awayTeamName ?? null,
            teamLogo: broadcast.awayTeamLogo ?? null,
            formation: deriveFormation(awayPlayers.filter((p: any) => p.position !== 'goalkeeper')),
            players: awayPlayers,
          },
        };
        await storage.upsertSportmonksCache(cacheKey, result);
        return result;
      } finally {
        lineupInFlight.delete(cacheKey);
      }
    })();

    lineupInFlight.set(cacheKey, promise);
    return promise;
  }

  async function fetchLineup(broadcastId: string, res: any) {
    const broadcast = await storage.getBroadcast(broadcastId);
    if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });

    if (!broadcast.sportmonksFixtureId) {
      return res.json({ available: false, message: 'No fixture linked to this broadcast' });
    }

    const fixtureId = broadcast.sportmonksFixtureId;
    const meta = (broadcast.metadata as any) || {};
    const homeTeamId: number | undefined = meta.homeTeamId;
    const awayTeamId: number | undefined = meta.awayTeamId;

    try {
      const data = await fetchLineupData(fixtureId, homeTeamId, awayTeamId, broadcast);
      return res.json(data);
    } catch (error: any) {
      console.error(`[Lineup] Sportmonks error for fixture ${fixtureId}:`, error.message);
      return res.status(502).json({ message: 'Failed to fetch lineup from Sportmonks', error: error.message });
    }
  }

  app.get('/api/broadcasts/:broadcastId/lineup', async (req, res) => {
    try {
      await fetchLineup(req.params.broadcastId, res);
    } catch (error: any) {
      console.error('Lineup error:', error.message);
      res.status(500).json({ message: 'Error fetching lineup', error: error.message });
    }
  });

  app.get('/v1/sdk/broadcasts/:broadcastId/lineup', async (req, res) => {
    try {
      await fetchLineup(req.params.broadcastId, res);
    } catch (error: any) {
      console.error('Lineup SDK error:', error.message);
      res.status(500).json({ message: 'Error fetching lineup', error: error.message });
    }
  });

  // POST /api/broadcasts/:broadcastId/send-lineup — Manual lineup_show trigger
  app.post('/api/broadcasts/:broadcastId/send-lineup', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });
      if (!broadcast.showLineup) return res.status(400).json({ success: false, error: 'showLineup is disabled for this broadcast' });
      if (!broadcast.sportmonksFixtureId) return res.status(400).json({ success: false, error: 'No fixture linked to this broadcast' });

      const now = Date.now();
      const broadcastStartedAt = broadcast.startedAt ? new Date(broadcast.startedAt).getTime() : now;
      const matchStartingAt = broadcast.matchStartingAt ? new Date(broadcast.matchStartingAt).getTime() : null;
      const leadTimeSeconds = 600; // 10 min before kickoff

      const kickoffVideoTimestamp = matchStartingAt
        ? Math.max(0, Math.round((matchStartingAt - broadcastStartedAt) / 1000))
        : 0;
      const videoTimestamp = Math.max(0, kickoffVideoTimestamp - leadTimeSeconds);

      const event = {
        type: 'lineup_show',
        videoTimestamp,
        kickoffVideoTimestamp,
        broadcastId,
        leadTimeSeconds,
        timestamp: new Date().toISOString(),
      };

      if (broadcast.campaignId) {
        broadcastToCampaign(broadcast.campaignId, JSON.stringify(event));
        lineupSentMap.set(broadcastId, now);
        console.log(`[Lineup] Sent lineup_show for broadcast ${broadcastId} — videoTimestamp=${videoTimestamp}s`);
      }

      res.json({ success: true, event });
    } catch (error: any) {
      console.error('send-lineup error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========================================
  // Broadcast Analytics Endpoint
  // ========================================
  app.get('/api/broadcasts/:broadcastId/analytics', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });

      const polls = await storage.getBroadcastPolls(broadcastId);
      const contests = await storage.getBroadcastContests(broadcastId);

      const totalVotes = polls.reduce((sum, p) => sum + (p.totalVotes ?? 0), 0);
      const activePolls = polls.filter(p => p.isActive).length;
      const activeContests = contests.filter(c => c.isActive).length;

      res.json({
        broadcastId,
        pollCount: polls.length,
        activePolls,
        contestCount: contests.length,
        activeContests,
        totalVotes,
        viewerCount: broadcast.viewerCount ?? 0,
        peakViewers: broadcast.peakViewers ?? 0,
        status: broadcast.status,
      });
    } catch (error) {
      res.status(500).json({ message: 'Error getting analytics' });
    }
  });

  // ========================================
  // Seed Demo Data Endpoint
  // ========================================
  app.post('/api/seed-demo', async (req, res) => {
    try {
      const { broadcastId } = req.body;
      if (!broadcastId) return res.status(400).json({ message: 'broadcastId is required' });

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ message: 'Broadcast not found' });

      const existingAds = await storage.getBroadcastAds(broadcastId);
      const existingProducts = await storage.getBroadcastProducts(broadcastId);
      const existingChat = await storage.getChatMessages(broadcastId, 1);

      if (existingAds.length === 0) {
        await storage.createBroadcastAd({ broadcastId, name: 'Nike Air Max Campaign', description: 'Exclusive limited edition drop for event attendees', imageUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400', ctaUrl: 'https://nike.com', adType: 'banner', duration: '30', isActive: true, displayOrder: 1 });
        await storage.createBroadcastAd({ broadcastId, name: 'Spotify Premium', description: '3 months free with your first purchase', imageUrl: 'https://images.unsplash.com/photo-1611532736597-de2d4265fba3?w=400', ctaUrl: 'https://spotify.com', adType: 'interstitial', duration: '15', isActive: true, displayOrder: 2 });
        await storage.createBroadcastAd({ broadcastId, name: 'Red Bull Energy', description: 'Fuel your passion. Available at the venue.', imageUrl: 'https://images.unsplash.com/photo-1568702846914-96b305d2aaeb?w=400', ctaUrl: 'https://redbull.com', adType: 'overlay', duration: '20', isActive: false, displayOrder: 3 });
      }

      if (existingProducts.length === 0) {
        await storage.createBroadcastProduct({ broadcastId, name: 'Official Team Jersey', subtitle: 'Limited Edition 2024 Season', price: '89.99', originalPrice: '129.99', imageUrl: 'https://images.unsplash.com/photo-1556821840-3a63f15732ce?w=400', buyUrl: 'https://shop.example.com/jersey', status: 'available', displayOrder: 1 });
        await storage.createBroadcastProduct({ broadcastId, name: 'Match Day Scarf', subtitle: 'Premium wool blend', price: '24.99', imageUrl: 'https://images.unsplash.com/photo-1609428613813-ef4e36b24059?w=400', buyUrl: 'https://shop.example.com/scarf', status: 'available', displayOrder: 2 });
        await storage.createBroadcastProduct({ broadcastId, name: 'Collector Cap', subtitle: 'Embroidered logo, adjustable fit', price: '34.99', originalPrice: '44.99', imageUrl: 'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?w=400', buyUrl: 'https://shop.example.com/cap', status: 'limited', displayOrder: 3 });
        await storage.createBroadcastProduct({ broadcastId, name: 'Fan Pack Bundle', subtitle: 'Jersey + Scarf + Cap', price: '129.99', originalPrice: '199.99', imageUrl: 'https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=400', buyUrl: 'https://shop.example.com/bundle', status: 'available', displayOrder: 4 });
      }

      if (existingChat.length === 0) {
        const chatData = [
          { username: 'carlos_fan', message: '¡Qué partido más increíble! 🔥' },
          { username: 'maria_sports', message: 'Best broadcast I\'ve seen this season!' },
          { username: 'javi_2024', message: 'The poll results are insane, did not see that coming' },
          { username: 'ana_vio', message: 'Love the shoppable products feature 🛍️' },
          { username: 'pedro_lv', message: 'Can\'t believe how smooth the stream is' },
          { username: 'lucia_mx', message: 'voted in the poll! Hope my team wins 🏆' },
          { username: 'rafael_it', message: 'Amazing production quality' },
          { username: 'sofia_br', message: 'Just bought the jersey!! So excited 😍' },
        ];
        for (const msg of chatData) {
          await storage.createChatMessage({ broadcastId, ...msg });
        }
      }

      res.json({ message: 'Demo data seeded successfully', broadcastId });
    } catch (error) {
      console.error('Error seeding demo data:', error);
      res.status(500).json({ message: 'Error seeding demo data' });
    }
  });

  app.get('/api/polls/:pollId/results', async (req, res) => {
    try {
      const pollId = parseInt(req.params.pollId);
      const results = await storage.getPollResults(pollId);
      if (!results) {
        return res.status(404).json({ message: 'Poll not found' });
      }
      const totalVotes = results.poll.totalVotes;
      const optionsWithPercentages = results.options.map(opt => ({
        ...opt,
        percentage: totalVotes > 0 ? Math.round((opt.voteCount / totalVotes) * 10000) / 100 : 0
      }));
      res.json({ ...results.poll, options: optionsWithPercentages });
    } catch (error) {
      console.error('Error getting poll results:', error);
      res.status(500).json({ message: 'Error getting poll results' });
    }
  });

  // POST /api/admin/polls/:pollId/seed-votes — Seed absolute vote counts for demo
  app.post('/api/admin/polls/:pollId/seed-votes', async (req, res) => {
    try {
      const pollId = parseInt(req.params.pollId);
      const { options } = req.body;
      if (!Array.isArray(options) || options.length === 0) {
        return res.status(400).json({ message: 'options array is required: [{ id, voteCount }]' });
      }
      const updated = await storage.seedPollVotes(pollId, options);
      if (!updated) return res.status(404).json({ message: 'Poll not found' });
      const results = await storage.getPollResults(pollId);
      res.json(results);
    } catch (error) {
      console.error('Error seeding poll votes:', error);
      res.status(500).json({ message: 'Error seeding poll votes' });
    }
  });

  // ========================================
  // SDK Endpoints (v1)
  // ========================================

  // Middleware to validate API key for SDK requests
  const validateApiKey = async (req: Request, res: any, next: any) => {
    try {
      const apiKey = req.query.apiKey as string || req.headers['x-api-key'] as string;

      if (!apiKey) {
        return res.status(401).json({ message: 'API key required' });
      }

      const clientApp = await storage.getClientAppByApiKey(apiKey);

      if (!clientApp) {
        return res.status(401).json({ message: 'Invalid API key' });
      }

      // Attach client app context to request for use in route handlers
      (req as any).clientApp = clientApp;
      next();
    } catch (error) {
      console.error('Error validating API key:', error);
      res.status(500).json({ message: 'Error validating API key' });
    }
  };

  // POST /api/checkout/confirm-apple-pay — Confirm Apple Pay payment via Stripe
  app.post('/api/checkout/confirm-apple-pay', validateApiKey, async (req, res) => {
    try {
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeSecretKey) {
        return res.status(503).json({ error: 'Payment processing not configured', code: 'STRIPE_NOT_CONFIGURED' });
      }

      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-01-27.acacia' });

      const { clientSecret, applePayToken, buyer } = req.body;

      if (!clientSecret || !applePayToken) {
        return res.status(400).json({ error: 'clientSecret and applePayToken are required', code: 'MISSING_PARAMS' });
      }

      // Decode the Apple Pay token (base64 → JSON)
      let tokenData: any;
      try {
        const decoded = Buffer.from(applePayToken, 'base64').toString('utf-8');
        tokenData = JSON.parse(decoded);
      } catch {
        return res.status(400).json({ error: 'Invalid applePayToken format', code: 'INVALID_TOKEN' });
      }

      // Create a payment method from the Apple Pay token
      const paymentMethod = await stripe.paymentMethods.create({
        type: 'card',
        card: { token: tokenData.token || tokenData } as any,
        billing_details: buyer ? {
          name: buyer.name || undefined,
          email: buyer.email || undefined,
          phone: buyer.phone || undefined,
          address: buyer.address ? {
            line1: buyer.address.street || undefined,
            city: buyer.address.city || undefined,
            postal_code: buyer.address.postalCode || undefined,
            country: buyer.address.country || undefined,
          } : undefined,
        } : undefined,
      });

      // Extract payment intent ID from clientSecret
      const intentId = clientSecret.split('_secret_')[0];

      // Confirm the payment intent
      const intent = await stripe.paymentIntents.confirm(intentId, {
        payment_method: paymentMethod.id,
      });

      const success = intent.status === 'succeeded';
      res.json({ success, orderId: intent.id, status: intent.status });
    } catch (error: any) {
      console.error('[Checkout] Apple Pay confirmation error:', error);
      if (error.type === 'StripeCardError') {
        return res.status(402).json({ error: error.message, code: 'CARD_ERROR' });
      }
      res.status(500).json({ error: 'Payment confirmation failed', code: 'PAYMENT_ERROR' });
    }
  });

  // ----------------------------------------------------------------------
  // Shoppable Ad dispatch — unified helper used by all 4 entry points.
  // Resolves product + sponsor via Commerce GraphQL, persists an activation
  // row, then fans out the WS event. Insertion happens on the origin node
  // only; Redis Pub/Sub fanout is payload-forward only (no duplicate writes).
  // ----------------------------------------------------------------------
  async function persistAndBroadcastShoppableAd(args: {
    broadcast: Broadcast;
    campaign: Campaign;
    productId: string | number;
    sponsorId?: number | null;
    slotId?: number | null;
    clientAppId?: number | null;
    source: 'admin-api' | 'dashboard' | 'tv-sdk' | 'slot-scheduler';
    req: Request;
  }): Promise<{ activationId: number; wsEvent: Record<string, any>; product: any; sponsor: any }> {
    const { broadcast, campaign, productId, sponsorId, slotId, clientAppId, source, req } = args;

    // 0. Sponsor must be primary OR a secondary of this campaign (validated for all sources
    //    except slot-scheduler which is authoritative by design — the slot already enforces its sponsor)
    if (sponsorId && source !== 'slot-scheduler') {
      const allowed = await storage.isSponsorAllowedForCampaign(sponsorId, campaign.id);
      if (!allowed) {
        const err: any = new Error('Sponsor is not associated with this campaign (must be primary or secondary)');
        err.status = 400;
        err.code = 'SPONSOR_NOT_IN_CAMPAIGN';
        throw err;
      }
    }

    // 1. Resolve sponsor (includes its Commerce API key if present). The SDK renders
    //    the shoppable overlay using the sponsor's **avatar** (square brand mark),
    //    not the full horizontal logo — enforce that here so the overlay never has to
    //    handle a missing avatar at display time.
    // Per the v2 rule "no hardcoded apiKeys": commerce key resolves strictly
    // per-sponsor (`sponsors.commerce_api_key`). If the dispatched sponsor has
    // no key configured (visual-only sponsor) the product enrichment is
    // skipped — the activation snapshot keeps the `Product #${productId}`
    // placeholder rather than authenticating against an unrelated channel.
    let sponsor: any = null;
    let commerceApiKey: string | null = null;
    if (sponsorId) {
      const sp = await storage.getSponsor(sponsorId);
      if (sp) {
        if (!sp.avatarUrl) {
          const err: any = new Error(`Sponsor ${sp.id} (${sp.name}) has no avatar_url — set one in the dashboard before dispatching shoppable ads`);
          err.status = 422;
          err.code = 'SPONSOR_MISSING_AVATAR';
          throw err;
        }
        if (sp.commerceApiKey) commerceApiKey = sp.commerceApiKey;
        sponsor = {
          id: sp.id,
          name: sp.name,
          avatarUrl: normalizeUrls(sp.avatarUrl, req.protocol, req.get('host')),
          logoUrl: sp.logoUrl ? normalizeUrls(sp.logoUrl, req.protocol, req.get('host')) : null,
          primaryColor: sp.primaryColor ?? null,
        };
      }
    }

    // 2. Resolve product from Commerce GraphQL — with a 2-step fallback:
    //    a) rich query (images + price) for the WS event + snapshot.
    //    b) if upstream fails (e.g. some products return `Cannot return null for
    //       non-nullable field Product.images.` — data-quality issue in Commerce),
    //       retry with a minimal `{ id title }` query so we at least get the
    //       product name into the push title + activation snapshot.
    //    c) if that also fails, fall back to `Product #X` placeholder.
    let product: any = null;
    if (commerceApiKey) {
      try {
        const richQuery = `{ Channel { GetProductsByIds(product_ids: [${productId}]) { id title images { url order } price { amount amount_incl_taxes currency_code } } } }`;
        const gqlData = await fetchGraphQL(richQuery, commerceApiKey);
        const p = gqlData?.data?.Channel?.GetProductsByIds?.[0];
        if (p) {
          const image = p.images?.sort((a: any, b: any) => a.order - b.order)?.[0];
          product = {
            id: String(p.id),
            name: p.title,
            price: p.price?.amount_incl_taxes ?? p.price?.amount ?? null,
            currency: p.price?.currency_code ?? 'NOK',
            imageUrl: image?.url ?? null,
          };
        }
      } catch (err) {
        console.warn(`[ShoppableAd:${source}] Commerce GraphQL rich query failed — retrying minimal:`, (err as Error).message ?? err);
        try {
          const minQuery = `{ Channel { GetProductsByIds(product_ids: [${productId}]) { id title } } }`;
          const gqlData = await fetchGraphQL(minQuery, commerceApiKey);
          const p = gqlData?.data?.Channel?.GetProductsByIds?.[0];
          if (p) {
            product = {
              id: String(p.id),
              name: p.title,
              price: null,
              currency: 'NOK',
              imageUrl: null,
            };
          }
        } catch (minErr) {
          console.warn(`[ShoppableAd:${source}] Commerce GraphQL minimal query also failed:`, (minErr as Error).message ?? minErr);
        }
      }
    } else {
      console.warn(`[ShoppableAd:${source}] No commerce key resolved (sponsorId=${sponsorId ?? '(none)'}) — skipping enrichment, using "Product #${productId}" placeholder`);
    }
    if (!product) {
      product = { id: String(productId), name: `Product #${productId}`, price: null, currency: 'NOK', imageUrl: null };
    }

    // 3. Persist activation BEFORE broadcasting. If DB fails, throw — callers translate to 500.
    //    We flag ws_event_sent=true optimistically; if the subsequent broadcast throws, we update it to false.
    const activation = await storage.createShoppableAdActivation({
      broadcastId: broadcast.broadcastId,
      campaignId: campaign.id,
      sponsorId: sponsorId ?? null,
      slotId: slotId ?? null,
      clientAppId: clientAppId ?? null,
      productId: String(productId),
      productSnapshot: product,
      sponsorSnapshot: sponsor,
      source,
      wsEventSent: true,
      metadata: null,
    });

    // 4. Build WS event (includes activationId for attribution + sponsorId for per-sponsor
    //    commerce-key routing on the SDK side via VioTVConfiguration.commerce(forSponsorId:))
    const wsEvent: Record<string, any> = {
      type: 'shoppable_ad',
      broadcastId: broadcast.broadcastId,
      campaignId: campaign.id,
      sponsorId: sponsorId ?? null,
      product,
      ...(sponsor ? { sponsor } : {}),
      ...(slotId ? { slotId } : {}),
      activationId: activation.id,
      timestamp: Date.now(),
    };

    // 5. Fan-out (Redis Pub/Sub if enabled, otherwise local only)
    try {
      if (campaign.id) broadcastToCampaign(campaign.id, JSON.stringify(wsEvent));
    } catch (err) {
      console.error(`[ShoppableAd:${source}] broadcastToCampaign failed, marking ws_event_sent=false for activation ${activation.id}`, err);
      // Best-effort flag update; swallow failures here so we don't mask the broadcast error
      try {
        await db.update(shoppableAdActivations)
          .set({ wsEventSent: false })
          .where(eq(shoppableAdActivations.id, activation.id));
      } catch {/* ignore */}
      throw err;
    }

    return { activationId: activation.id, wsEvent, product, sponsor };
  }

  // POST /api/broadcasts/:id/shoppable-ad — Admin Bearer trigger (source=admin-api)
  app.post('/v2/admin/broadcasts/:broadcastId/shoppable-ad', requireBearerAuth, async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const { productId, sponsorId } = req.body;
      if (!productId) return res.status(400).json({ error: 'productId is required' });

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
      if (!broadcast.campaignId) return res.status(400).json({ error: 'Broadcast has no associated campaign' });
      const campaign = await storage.getCampaign(broadcast.campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      const { activationId, product, sponsor } = await persistAndBroadcastShoppableAd({
        broadcast, campaign, productId,
        sponsorId: sponsorId ? Number(sponsorId) : null,
        source: 'admin-api', req,
      });
      res.json({ success: true, activationId, product, sponsor });
    } catch (error: any) {
      console.error('[ShoppableAd:admin-api] Error:', error);
      if (error?.status) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(500).json({ error: 'Failed to trigger shoppable ad' });
    }
  });

  // POST /api/broadcasts/:broadcastId/trigger-shoppable-ad — Dashboard trigger (source=dashboard, no auth)
  app.post('/api/broadcasts/:broadcastId/trigger-shoppable-ad', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const { productId, sponsorId } = req.body;
      if (!productId) return res.status(400).json({ error: 'productId is required' });

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
      if (!broadcast.campaignId) return res.status(400).json({ error: 'Broadcast has no associated campaign' });
      const campaign = await storage.getCampaign(broadcast.campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      const { activationId, product, sponsor } = await persistAndBroadcastShoppableAd({
        broadcast, campaign, productId,
        sponsorId: sponsorId ? Number(sponsorId) : null,
        source: 'dashboard', req,
      });

      res.json({ success: true, activationId, product, sponsor });
    } catch (error: any) {
      console.error('[ShoppableAd:dashboard] Error:', error);
      if (error?.status) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(500).json({ error: 'Failed to trigger shoppable ad' });
    }
  });

  // GET /api/broadcasts/:id/sponsor-slots
  app.get('/api/broadcasts/:broadcastId/sponsor-slots', async (req, res) => {
    try {
      const slots = await storage.getBroadcastSponsorSlots(req.params.broadcastId);
      res.json(slots);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch sponsor slots' });
    }
  });

  // POST /api/broadcasts/:id/sponsor-slots
  app.post('/api/broadcasts/:broadcastId/sponsor-slots', async (req, res) => {
    try {
      const parsed = insertBroadcastSponsorSlotSchema.safeParse({ ...req.body, broadcastId: req.params.broadcastId });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const slot = await storage.createBroadcastSponsorSlot(parsed.data);
      res.status(201).json(slot);
    } catch (error: any) {
      console.error('[sponsor-slots POST]', error?.message ?? error);
      res.status(500).json({ error: 'Failed to create sponsor slot', detail: error?.message });
    }
  });

  // PUT /api/broadcasts/:id/sponsor-slots/:slotId
  app.put('/api/broadcasts/:broadcastId/sponsor-slots/:slotId', async (req, res) => {
    try {
      const slot = await storage.updateBroadcastSponsorSlot(parseInt(req.params.slotId), req.body);
      if (!slot) return res.status(404).json({ error: 'Slot not found' });
      res.json(slot);
    } catch (error) {
      res.status(500).json({ error: 'Failed to update sponsor slot' });
    }
  });

  // DELETE /api/broadcasts/:id/sponsor-slots/:slotId
  app.delete('/api/broadcasts/:broadcastId/sponsor-slots/:slotId', async (req, res) => {
    try {
      await storage.deleteBroadcastSponsorSlot(parseInt(req.params.slotId));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete sponsor slot' });
    }
  });

  // POST /api/broadcasts/:id/sponsor-slots/:slotId/execute — Fire the slot as WS event (source=slot-scheduler)
  app.post('/api/broadcasts/:broadcastId/sponsor-slots/:slotId/execute', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const slotId = parseInt(req.params.slotId);
      const slot = await storage.getBroadcastSponsorSlot(slotId);
      if (!slot) return res.status(404).json({ error: 'Slot not found' });

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
      if (!broadcast.campaignId) return res.status(400).json({ error: 'Broadcast has no associated campaign' });
      const campaign = await storage.getCampaign(broadcast.campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      const productIds: (number | string)[] = slot.productIds ?? [];
      const productId = productIds[0] ?? 'unknown';

      // Persist & broadcast first — only mark the slot completed if this succeeds,
      // so we never leave a slot in 'completed' state without an activation row.
      const { activationId, product, sponsor } = await persistAndBroadcastShoppableAd({
        broadcast, campaign, productId,
        sponsorId: slot.sponsorId,
        slotId,
        source: 'slot-scheduler', req,
      });

      await storage.updateBroadcastSponsorSlot(slotId, { status: 'completed', executedAt: new Date() });

      res.json({ success: true, activationId, product, sponsor });
    } catch (error: any) {
      console.error('[ShoppableAd:slot-scheduler] Execute error:', error);
      if (error?.status) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(500).json({ error: 'Failed to execute sponsor slot' });
    }
  });

  // POST /api/sdk/tv/broadcasts/:broadcastId/shoppable-ad — TV SDK trigger (API Key auth, source=tv-sdk)
  // Uses the same apiKey model as mobile SDK endpoints but on a dedicated path so TV-specific
  // behaviours (reporting, rate limits, analytics) can diverge cleanly over time.
  app.post('/v2/tv/broadcasts/:broadcastId/shoppable-ad', validateApiKey, async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const { productId, sponsorId } = req.body ?? {};
      if (!productId) return res.status(400).json({ error: 'productId is required' });

      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
      if (!broadcast.campaignId) return res.status(400).json({ error: 'Broadcast has no associated campaign' });
      const campaign = await storage.getCampaign(broadcast.campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      const clientApp = (req as any).clientApp;
      const { activationId, product, sponsor } = await persistAndBroadcastShoppableAd({
        broadcast, campaign, productId,
        sponsorId: sponsorId ? Number(sponsorId) : null,
        clientAppId: clientApp?.id ?? null,
        source: 'tv-sdk', req,
      });
      res.json({ success: true, activationId, product, sponsor });
    } catch (error: any) {
      console.error('[ShoppableAd:tv-sdk] Error:', error);
      if (error?.status) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(500).json({ error: 'Failed to trigger shoppable ad' });
    }
  });

  // GET /api/broadcasts/:broadcastId/shoppable-ads — List activation history for a broadcast
  // Session auth not enforced here (mirrors existing event-log endpoints in this file).
  app.get('/api/broadcasts/:broadcastId/shoppable-ads', async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const limit = Math.min(parseInt(String(req.query.limit ?? '50')) || 50, 200);
      const offset = parseInt(String(req.query.offset ?? '0')) || 0;
      const sponsorId = req.query.sponsorId ? Number(req.query.sponsorId) : undefined;
      const source = req.query.source ? String(req.query.source) : undefined;

      const rows = await storage.listShoppableAdActivationsByBroadcast(broadcastId, {
        limit, offset, sponsorId, source,
      });
      res.json({ activations: rows, limit, offset, count: rows.length });
    } catch (error) {
      console.error('[ShoppableAd:list] Error:', error);
      res.status(500).json({ error: 'Failed to list shoppable ad activations' });
    }
  });

  // GET /api/commerce/products?sponsorId=:id OR ?campaignId=:id — Fetch products from Commerce GraphQL
  app.get('/v2/commerce/products', async (req, res) => {
    try {
      const sponsorId = req.query.sponsorId ? parseInt(req.query.sponsorId as string) : null;
      const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string) : null;

      // Per the v2 rule "no hardcoded apiKeys": commerce key resolves strictly
      // per-sponsor. Falls back across campaign sponsors when only campaignId
      // is supplied. If no sponsor in scope has a key, returns an empty list
      // rather than authenticating against an unrelated channel.
      let commerceApiKey: string | null = null;

      // Prefer sponsor-level key. Falls back to all campaign sponsors
      // (primary first, then secondaries) via `getAllCampaignSponsors`.
      if (sponsorId) {
        const sp = await storage.getSponsor(sponsorId);
        if (sp?.commerceApiKey) commerceApiKey = sp.commerceApiKey;
      } else if (campaignId) {
        const allSponsors = await storage.getAllCampaignSponsors(campaignId);
        for (const sp of allSponsors) {
          if (sp?.commerceApiKey) { commerceApiKey = sp.commerceApiKey; break; }
        }
      }

      let productIds: number[] = [];
      if (campaignId) {
        const broadcasts = await storage.getBroadcastsByCampaign(campaignId);
        for (const broadcast of broadcasts) {
          const slots = await storage.getBroadcastSponsorSlots(broadcast.broadcastId);
          for (const slot of slots) {
            if (slot.productIds) productIds.push(...slot.productIds);
          }
        }
        productIds = [...new Set(productIds)];
      }

      if (productIds.length === 0) {
        productIds = [408841, 408874, 408895, 408896, 408898];
      }

      if (!commerceApiKey) {
        console.warn(`[Commerce] No commerce key resolved for sponsorId=${sponsorId ?? '(none)'} campaignId=${campaignId ?? '(none)'} — returning empty list`);
        return res.json([]);
      }

      const gqlQuery = `{ Channel { GetProductsByIds(product_ids: [${productIds.join(',')}]) { id title images { url order } price { amount amount_incl_taxes currency_code } } } }`;
      const gqlData = await fetchGraphQL(gqlQuery, commerceApiKey);
      const raw = gqlData?.data?.Channel?.GetProductsByIds ?? [];
      const products = raw.map((p: any) => {
        const image = p.images?.sort((a: any, b: any) => a.order - b.order)?.[0];
        return { id: p.id, name: p.title, imageUrl: image?.url ?? null, price: p.price?.amount_incl_taxes ?? p.price?.amount ?? null, currency: p.price?.currency_code ?? 'NOK' };
      });

      res.json(products);
    } catch (error) {
      console.error('[Commerce] Products error:', error);
      res.status(500).json({ error: 'Failed to fetch Commerce products' });
    }
  });

  // GET /api/commerce/sponsors/:sponsorId/catalog — list a sponsor's full Commerce catalog
  // (used by the dashboard slot picker to browse a sponsor's channel before saving the
  // chosen productId on a broadcast_sponsor_slot). Auth boundary: 404 if sponsor missing,
  // 422 if the sponsor has no commerce_api_key wired (visual-only sponsors can't sell).
  // Search filtering is performed client-side from the returned page since the upstream
  // GraphQL `Channel.GetProducts` does not expose a search argument today.
  app.get('/v2/commerce/sponsors/:sponsorId/catalog', async (req, res) => {
    try {
      const sponsorId = parseInt(req.params.sponsorId);
      if (!Number.isFinite(sponsorId)) {
        return res.status(400).json({ error: 'Invalid sponsorId' });
      }

      const sponsor = await storage.getSponsor(sponsorId);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      if (!sponsor.commerceApiKey) {
        return res.status(422).json({
          error: `Sponsor ${sponsor.id} (${sponsor.name}) has no commerce key — cannot list a catalog`,
          code: 'SPONSOR_MISSING_COMMERCE_KEY',
        });
      }

      const shippingCountryCode = (req.query.shippingCountryCode as string) || 'NO';
      const currency = (req.query.currency as string) || 'NOK';
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const gqlQuery = `
        query GetCatalog($shippingCountryCode: String, $currency: String) {
          Channel {
            GetProducts(shipping_country_code: $shippingCountryCode, currency: $currency) {
              id
              title
              sku
              description
              images { id url height order }
              price {
                amount
                currency_code
                amount_incl_taxes
                tax_amount
                tax_rate
                compare_at
                compare_at_incl_taxes
              }
            }
          }
        }
      `;

      const gqlData = await fetchGraphQL(gqlQuery, sponsor.commerceApiKey, 3, {
        shippingCountryCode,
        currency,
      });
      const all = (gqlData?.data?.Channel?.GetProducts ?? []) as any[];

      const products = all.map((p) => {
        const image = p.images?.slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))?.[0];
        return {
          id: p.id,
          name: p.title,
          sku: p.sku ?? null,
          description: p.description ?? null,
          imageUrl: image?.url ?? null,
          price: p.price?.amount_incl_taxes ?? p.price?.amount ?? null,
          currency: p.price?.currency_code ?? currency,
        };
      });

      const total = products.length;
      const page = products.slice(offset, offset + limit);

      res.json({
        sponsor: { id: sponsor.id, name: sponsor.name },
        products: page,
        total,
        limit,
        offset,
        hasMore: offset + page.length < total,
      });
    } catch (error: any) {
      console.error('[Commerce catalog] Error:', error?.message ?? error);
      res.status(502).json({ error: 'Failed to fetch sponsor catalog from Commerce', detail: error?.message });
    }
  });

  // POST /api/campaigns/:id/register-device — Register APNs device token (SDK partner apps; used for Vio-side push fallback)
  app.post('/v2/mobile/campaigns/:campaignId/register-device', validateApiKey, async (req, res) => {
    try {
      const campaignId = parseInt(req.params.campaignId);
      const clientApp = (req as any).clientApp;
      const { userId, deviceToken, platform = 'ios' } = req.body;

      if (!userId || !deviceToken) {
        return res.status(400).json({ error: 'userId and deviceToken are required' });
      }

      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (campaign.clientAppId !== clientApp.id) {
        return res.status(403).json({ error: 'Campaign does not belong to this API key' });
      }

      await storage.upsertDeviceToken(campaignId, String(userId), String(deviceToken), String(platform));
      console.log(`[RegisterDevice] campaign=${campaignId} userId=${userId} platform=${platform}`);

      const partnerRegisterUrl = clientApp.partnerDeviceRegisterUrl?.trim();
      if (partnerRegisterUrl) {
        try {
          const fwd = await fetch(partnerRegisterUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: String(userId),
              deviceToken: String(deviceToken),
              platform: String(platform),
            }),
          });
          console.log(`[RegisterDevice] Partner device register forward → ${partnerRegisterUrl} HTTP ${fwd.status}`);
        } catch (forwardErr) {
          console.error('[RegisterDevice] Partner device register forward failed:', forwardErr);
        }
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[RegisterDevice] Error:', error);
      res.status(500).json({ error: 'Failed to register device' });
    }
  });

  // POST /api/campaigns/:id/cart-intent — TV adds to cart -> broadcast WS or webhook (partner-first)
  // Accepts optional `activationId` to close the attribution chain (shoppable_ad → cart_intent → purchase).
  // Persists a row in cart_intents for later analytics.
  app.post('/v2/mobile/campaigns/:campaignId/cart-intent', validateApiKey, async (req, res) => {
    try {
      const campaignId = parseInt(req.params.campaignId);
      const clientApp = (req as any).clientApp;
      const { productId, userId, productName, activationId, sponsorId } = req.body;

      // Validate campaign belongs to this API key's clientApp
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (campaign.clientAppId !== clientApp.id) {
        return res.status(403).json({ error: 'Campaign does not belong to this API key' });
      }

      if (!productId || !userId) {
        return res.status(400).json({ error: 'productId and userId are required' });
      }

      // Resolve product name via Commerce — uses the sponsor's per-sponsor
      // commerceApiKey from `sponsors.commerce_api_key`. Per the v2 rule
      // "no hardcoded apiKeys", route to the right key based on the
      // sponsorId passed in the body (or derived from activationId below
      // when needed). Falls back across `campaign_sponsors` when the
      // supplied sponsorId has no key configured. If no sponsor in the
      // campaign has a key, name resolution is skipped — the push notif
      // keeps the `Product ${productId}` placeholder rather than crashing.
      // (Same pattern as `/v2/tv/cart-intent` and `/v2/commerce/products`.)
      let resolvedName = productName || `Product ${productId}`;
      if (!productName) {
        let resolvedCommerceKey: string | null = null;
        if (sponsorId) {
          const sp = await storage.getSponsor(Number(sponsorId));
          if (sp?.commerceApiKey) resolvedCommerceKey = sp.commerceApiKey;
        }
        if (!resolvedCommerceKey) {
          // Fallback: iterate `[primary, ...secondaries]` for the first
          // sponsor with a commerce key. Primary first per storage convention.
          const allSponsors = await storage.getAllCampaignSponsors(campaign.id);
          for (const csp of allSponsors) {
            if (csp?.commerceApiKey) { resolvedCommerceKey = csp.commerceApiKey; break; }
          }
        }
        if (resolvedCommerceKey) {
          try {
            const gqlQuery = `{ Channel { GetProductsByIds(product_ids: [${productId}]) { id title images { url order } price { amount amount_incl_taxes currency_code } } } }`;
            const gqlData = await fetchGraphQL(gqlQuery, resolvedCommerceKey);
            const name = gqlData?.data?.Channel?.GetProductsByIds?.[0]?.title;
            if (name) resolvedName = name;
          } catch (err) {
            console.warn('[CartIntent] Commerce lookup failed:', err);
          }
        } else {
          console.warn(`[CartIntent] No commerce key resolved for sponsorId=${sponsorId ?? '(none)'} campaignId=${campaign.id} — using placeholder "${resolvedName}" in push notif`);
        }
      }

      const normalizedUserId = String(userId).trim();

      // Build the canonical envelope once — used by WS, partner webhook, APNs and persistence.
      // Mobile-path callers historically have not propagated activation_id/sponsor_id into the
      // payload (only into the persisted row); preserve that until we explicitly migrate the
      // mobile contract. TV-path callers do propagate them — see below.
      const envelope = buildCartIntentEnvelope({
        userId: String(userId),
        campaignId,
        productId,
        productName: resolvedName,
        clientAppName: clientApp.name,
      });

      const wsEvent = {
        type: 'cart_intent',
        ...envelope,
        timestamp: new Date().toISOString(),
      };

      const { deliveryMode, userConnected } = await routeUserEvent({
        userId: normalizedUserId,
        clientApp,
        envelope,
        wsEvent,
        campaignIdForDeviceLookup: campaignId,
      });

      // Persist cart_intent with attribution chain (source_activation_id) for later analytics.
      // Ensure-user: resolves (client_app, externalUserId) to the end_users row, creating if needed.
      let cartIntentId: number | null = null;
      try {
        const endUser = await storage.ensureEndUser(clientApp.id, normalizedUserId);
        const created = await storage.createCartIntent({
          endUserId: endUser.id,
          campaignId,
          clientAppId: clientApp.id,
          tvSessionId: null,
          sponsorId: sponsorId ? Number(sponsorId) : null,
          productId: String(productId),
          sourceActivationId: activationId ? Number(activationId) : null,
          sourceComponentId: null,
          deliveryMode,
          userConnected,
          envelope,
          metadata: null,
        });
        cartIntentId = created.id;
      } catch (persistErr) {
        console.error('[UserEvent:cart_intent] persist failed (non-fatal):', persistErr);
      }

      res.json({
        success: true,
        mode: deliveryMode,
        userConnected,
        envelope,
        cartIntentId,
      });
    } catch (error) {
      console.error('[UserEvent:cart_intent] mobile handler error:', error);
      res.status(500).json({ error: 'Failed to process cart intent' });
    }
  });

  // GET /v1/sdk/broadcast - Validate contentId and get broadcast engagement data
  // SDK calls this when a user opens a specific stream/content
  // (NOTE: /v1/sdk/campaigns retired in commit 374a3ae after grep confirmed
  // 0 callers across iOS / Apple TV / dashboard. Alan's commits c49ebca +
  // acaa3e8 added a `sponsor: cc.sponsor` field to that endpoint's
  // response — those refactors live now in `storage.getCampaignComponents`
  // via the formatSponsor helper, available to any future v2 endpoint
  // that wants the same shape.)
  app.get('/v1/sdk/broadcast', async (req, res) => {
    try {
      // Auth: API key only (bundle ID reserved for future use)
      const apiKey = req.query.apiKey as string || req.headers['x-api-key'] as string;
      const contentId = req.query.contentId as string | undefined;
      const country = req.query.country as string | undefined;

      if (!contentId) {
        return res.status(400).json({ message: 'contentId query parameter is required' });
      }

      if (!apiKey) {
        return res.status(401).json({ message: 'API key required' });
      }

      const clientApp = await storage.getClientAppByApiKey(apiKey);
      if (!clientApp) {
        return res.status(401).json({ message: 'Invalid API key' });
      }

      const broadcast = await storage.getBroadcastByExternalId(contentId, clientApp.id);

      if (!broadcast) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ hasEngagement: false });
      }

      if (!broadcast.campaignId) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ hasEngagement: false });
      }

      const campaign = await storage.getCampaign(broadcast.campaignId);
      if (!campaign) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ hasEngagement: false });
      }

      // Check if campaign is active
      const now = new Date();
      const isPaused = campaign.isPaused === 'true';
      const startDate = campaign.startDate ? new Date(campaign.startDate) : null;
      const endDate = campaign.endDate ? new Date(campaign.endDate) : null;
      const isWithinDates = (!startDate || startDate <= now) && (!endDate || endDate >= now);

      if (isPaused || !isWithinDates) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json({ hasEngagement: false });
      }

      // Filter by country if provided
      if (country && campaign.targetCountries && campaign.targetCountries.length > 0) {
        if (!campaign.targetCountries.includes(country)) {
          res.set('Cache-Control', 'public, max-age=30');
          return res.json({ hasEngagement: false });
        }
      }

      // Get campaign-level active components
      const components = await storage.getCampaignComponents(broadcast.campaignId);
      const campaignComponents = components
        .filter(c => c.status === 'active')
        .map(cc => ({
          id: cc.componentId,
          type: cc.component.type,
          name: cc.instanceName || cc.component.name,
          config: normalizeUrls(cc.customConfig || cc.component.config, req.protocol, req.get('host')),
          status: cc.status
        }));

      // Get broadcast-level components (polls, contests)
      const [pollsList, contestsList] = await Promise.all([
        storage.getBroadcastPolls(broadcast.broadcastId),
        storage.getBroadcastContests(broadcast.broadcastId)
      ]);

      const activePolls = pollsList.filter(p => p.isActive);
      const activeContests = contestsList.filter(c => c.isActive);

      const responseData: any = {
        hasEngagement: true,
        broadcastId: broadcast.broadcastId,
        broadcastName: broadcast.broadcastName,
        status: broadcast.status,
        campaignId: campaign.id,
        campaignName: campaign.name,
        campaignLogo: campaign.logo ? toAbsoluteUrl(campaign.logo, req) : null,
        websocketChannel: `/ws/${campaign.id}`,
        campaignComponents,
        broadcastComponents: {
          chat: { enabled: true },
          polls: activePolls.map(p => ({
            id: p.id,
            question: p.question,
            isActive: p.isActive,
            duration: p.duration,
            options: p.options.map(o => ({ id: o.id, text: o.text }))
          })),
          contests: activeContests.map(c => ({
            id: c.id,
            title: c.title,
            prize: c.prize,
            isActive: c.isActive,
            endTime: c.endTime
          }))
        }
      };

      res.set('Cache-Control', 'private, max-age=10');
      res.set('ETag', `"${broadcast.broadcastId}-${broadcast.status}"`);
      res.json(responseData);
    } catch (error) {
      console.error('Error fetching SDK broadcast:', error);
      res.status(500).json({ message: 'Error fetching SDK broadcast' });
    }
  });

  // GET /v1/campaigns/:campaignId/config - Complete dynamic campaign configuration
  app.get('/v1/campaigns/:campaignId/config', validateApiKey, async (req, res) => {
    try {
      const clientApp = (req as any).clientApp;
      const campaignId = parseInt(req.params.campaignId);
      const matchId = req.query.matchId as string | undefined;

      if (isNaN(campaignId)) {
        return res.status(400).json({
          error: 'Invalid campaignId',
          code: 'INVALID_PARAMETERS'
        });
      }

      // Get full campaign config
      const fullConfig = await storage.getFullCampaignConfig(campaignId);

      if (!fullConfig) {
        return res.status(404).json({
          error: 'Campaign not found',
          code: 'CAMPAIGN_NOT_FOUND'
        });
      }

      const { campaign, translations, engagementConfig, uiConfig, featureFlags } = fullConfig;

      // Verify campaign belongs to this client app — direct match or via channel (legacy)
      const directMatch = campaign.clientAppId === clientApp.id;
      let channelMatch = false;
      let channel = null;
      if (campaign.channelId) {
        channel = await storage.getChannel(campaign.channelId);
        channelMatch = !!(channel && channel.clientAppId === clientApp.id);
      }
      if (!directMatch && !channelMatch) {
        return res.status(403).json({
          error: 'Campaign does not belong to this API key',
          code: 'FORBIDDEN'
        });
      }

      // Build sponsorBadgeText from translations
      const sponsorBadgeText: Record<string, string> = {};
      const defaultSponsorBadgeText: Record<string, string> = {
        'no': 'Sponset av',
        'en': 'Sponsored by',
        'sv': 'Sponsrad av'
      };

      for (const t of translations) {
        if (t.sponsorBadgeText) {
          sponsorBadgeText[t.languageCode] = t.sponsorBadgeText;
        }
      }

      // Merge with defaults
      const finalSponsorBadgeText = { ...defaultSponsorBadgeText, ...sponsorBadgeText };

      // Resolve sponsor for brand data (sponsor takes priority over campaign brand fields)
      const sponsor = await storage.getSponsor(campaign.primarySponsorId);

      // Build response with defaults for missing configs
      const config = {
        campaignId: campaign.id,
        version: '1.0.0',
        brand: {
          name: sponsor?.name || campaign.brandName || campaign.name || 'Vio',
          iconAsset: campaign.brandIconAsset || 'avatar_default',
          iconUrl: (sponsor?.avatarUrl ? toAbsoluteUrl(sponsor.avatarUrl, req) : null) || (campaign.brandIconUrl ? toAbsoluteUrl(campaign.brandIconUrl, req) : null),
          logoUrl: (sponsor?.logoUrl ? toAbsoluteUrl(sponsor.logoUrl, req) : null) || (campaign.brandLogoUrl ? toAbsoluteUrl(campaign.brandLogoUrl, req) : null),
          sponsorBadgeText: finalSponsorBadgeText
        },
        engagement: {
          demoMode: engagementConfig?.demoMode === 'true' || false,
          defaultPollDuration: engagementConfig?.defaultPollDuration ?? 300,
          defaultContestDuration: engagementConfig?.defaultContestDuration ?? 600,
          maxVotesPerPoll: engagementConfig?.maxVotesPerPoll ?? 1,
          maxContestsPerMatch: engagementConfig?.maxContestsPerMatch ?? 10,
          enableRealTimeUpdates: engagementConfig?.enableRealTimeUpdates !== 'false',
          updateInterval: engagementConfig?.updateInterval ?? 1000
        },
        ui: {
          theme: {
            primaryColor: uiConfig?.primaryColor || '#007AFF',
            secondaryColor: uiConfig?.secondaryColor || '#5856D6'
          },
          components: uiConfig?.componentConfigs || {}
        },
        features: {
          enableLiveStreaming: featureFlags?.enableLiveStreaming !== 'false',
          enableProductCatalog: featureFlags?.enableProductCatalog !== 'false',
          enableEngagement: featureFlags?.enableEngagement !== 'false',
          enablePolls: featureFlags?.enablePolls !== 'false',
          enableContests: featureFlags?.enableContests !== 'false',
          enableChat: featureFlags?.enableChat !== 'false'
        },
        cache: {
          ttl: 300,
          version: '1.0.0'
        }
      } as any;

      // Include sponsor branding if campaign has a sponsor (already fetched above)
      if (sponsor) {
        config.sponsor = {
          id: sponsor.id,
          name: sponsor.name,
          logoUrl: sponsor.logoUrl ? toAbsoluteUrl(sponsor.logoUrl, req) : null,
          avatarUrl: sponsor.avatarUrl ? toAbsoluteUrl(sponsor.avatarUrl, req) : null,
          primaryColor: sponsor.primaryColor || null,
          secondaryColor: sponsor.secondaryColor || null,
          badgeText: finalSponsorBadgeText,
        };
      }

      const {
        apiKey: sdkCommerceApiKey2,
        channelId: sdkCommerceChannelId2,
      } = await resolveCommerceFromCampaignSponsors(campaign.id);
      config.integrations = {
        commerce: {
          enabled: !!(sdkCommerceApiKey2),
          apiKey: sdkCommerceApiKey2,
          channelId: sdkCommerceChannelId2,
        }
      };

      // Checkout config — payment methods enabled for this campaign
      config.checkout = {
        paymentMethods: (campaign.paymentMethods as string[] | null) || ["apple_pay"],
      };

      res.set('Cache-Control', 'public, max-age=300');
      res.json(config);
    } catch (error) {
      console.error('Error fetching campaign config:', error);
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  });

  // GET /v1/engagement/config - Engagement configuration for a match
  app.get('/v1/engagement/config', validateApiKey, async (req, res) => {
    try {
      const matchId = req.query.matchId as string | undefined;

      if (!matchId) {
        return res.status(400).json({
          error: 'Missing required parameter: matchId',
          code: 'MISSING_PARAMETER'
        });
      }

      // Find campaigns associated with this matchId
      const allCampaigns = await storage.getAllCampaigns();
      const matchCampaign = allCampaigns.find(c => c.matchId === matchId);

      if (!matchCampaign) {
        return res.status(404).json({
          error: 'Engagement config not found for matchId',
          code: 'CONFIG_NOT_FOUND'
        });
      }

      // Get engagement config for this campaign
      const engagementConfig = await storage.getCampaignEngagementConfig(matchCampaign.id);

      const config = {
        matchId,
        engagement: {
          demoMode: engagementConfig?.demoMode === 'true' || false,
          defaultPollDuration: engagementConfig?.defaultPollDuration ?? 300,
          defaultContestDuration: engagementConfig?.defaultContestDuration ?? 600,
          maxVotesPerPoll: engagementConfig?.maxVotesPerPoll ?? 1,
          enableRealTimeUpdates: engagementConfig?.enableRealTimeUpdates !== 'false'
        },
        cache: {
          ttl: 300
        }
      };

      res.set('Cache-Control', 'public, max-age=300');
      res.json(config);
    } catch (error) {
      console.error('Error fetching engagement config:', error);
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  });

  // GET /v1/localization/:language - Localized strings
  app.get('/v1/localization/:language', validateApiKey, async (req, res) => {
    try {
      const language = req.params.language;
      const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string) : undefined;
      const matchId = req.query.matchId as string | undefined;

      const supportedLanguages = ['no', 'en', 'sv', 'es', 'de', 'fr', 'da', 'fi'];
      if (!supportedLanguages.includes(language)) {
        return res.status(400).json({
          error: 'Invalid language code',
          code: 'INVALID_LANGUAGE'
        });
      }

      // Get translations with priority: match > campaign > global
      const translations = await storage.getSdkTranslations(language, campaignId, matchId);

      // Default translations
      const defaultTranslations: Record<string, Record<string, string>> = {
        'no': {
          sponsorBadge: 'Sponset av',
          voteButton: 'Stem',
          participateButton: 'Delta',
          pollClosed: 'Avstemningen er stengt',
          alreadyVoted: 'Du har allerede stemt',
          contestEnded: 'Konkurransen er avsluttet'
        },
        'en': {
          sponsorBadge: 'Sponsored by',
          voteButton: 'Vote',
          participateButton: 'Participate',
          pollClosed: 'Poll is closed',
          alreadyVoted: 'You have already voted',
          contestEnded: 'Contest has ended'
        },
        'sv': {
          sponsorBadge: 'Sponsrad av',
          voteButton: 'Rösta',
          participateButton: 'Delta',
          pollClosed: 'Omröstningen är stängd',
          alreadyVoted: 'Du har redan röstat',
          contestEnded: 'Tävlingen har avslutats'
        }
      };

      // Build translations object
      const translationsObj: Record<string, string> = { ...(defaultTranslations[language] || defaultTranslations['en']) };

      for (const t of translations) {
        translationsObj[t.translationKey] = t.translationValue;
      }

      const dateFormats: Record<string, string> = {
        'no': 'dd.MM.yyyy',
        'en': 'MM/dd/yyyy',
        'sv': 'yyyy-MM-dd'
      };

      const timeFormats: Record<string, string> = {
        'no': 'HH:mm',
        'en': 'h:mm a',
        'sv': 'HH:mm'
      };

      const response = {
        language,
        campaignId: campaignId || null,
        translations: translationsObj,
        dateFormat: translations[0]?.dateFormat || dateFormats[language] || 'dd.MM.yyyy',
        timeFormat: translations[0]?.timeFormat || timeFormats[language] || 'HH:mm',
        cache: {
          ttl: 3600
        }
      };

      res.set('Cache-Control', 'public, max-age=3600');
      res.json(response);
    } catch (error) {
      console.error('Error fetching localization:', error);
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  });


  // ==================================================================
  // v2 SDK endpoints — multi-sponsor redesign (see docs/multi-sponsor-architecture.md)
  // ==================================================================

  /**
   * Helper: build the sponsor block for the /v2/sdk/config response.
   * Returns the canonical shape the SDK consumes.
   */
  async function buildSponsorBlock(sponsorId: number) {
    const sp = await storage.getSponsor(sponsorId);
    if (!sp) return null;
    const hasCommerce = !!sp.commerceApiKey;
    const publicHost = process.env.PUBLIC_BASE_URL || 'api-dev.vio.live';
    return {
      id: sp.id,
      name: sp.name,
      // `avatarUrl` is the square brand mark rendered inside shoppable overlays / product
      // cards. `logoUrl` is the wide horizontal logo used for sponsor intros / full-screen
      // branding. Both ship so the SDK can pick the right one for each surface.
      avatarUrl: sp.avatarUrl ? normalizeUrls(sp.avatarUrl, 'https', publicHost) : null,
      logoUrl: sp.logoUrl ? normalizeUrls(sp.logoUrl, 'https', publicHost) : null,
      primaryColor: sp.primaryColor ?? null,
      secondaryColor: sp.secondaryColor ?? null,
      commerce: hasCommerce
        ? {
            apiKey: sp.commerceApiKey,
            channelId: sp.commerceChannelId ?? null,
            paymentMethods: Array.isArray(sp.paymentMethods) ? sp.paymentMethods : [],
          }
        : null,
    };
  }

  // GET /v2/sdk/config — primary + secondary sponsors with commerce per sponsor
  app.get('/v2/mobile/config', validateApiKey, async (req, res) => {
    try {
      const clientApp = (req as any).clientApp;
      const appCampaigns = await storage.getClientAppCampaigns(clientApp.id);
      const now = new Date();
      const activeCampaign = appCampaigns.find(c =>
        (!c.startDate || new Date(c.startDate) <= now) &&
        (!c.endDate || new Date(c.endDate) >= now) &&
        c.isPaused !== 'true'
      ) || appCampaigns[0] || null;

      if (!activeCampaign) {
        return res.status(404).json({ error: 'No campaign configured for this client app' });
      }
      if (!activeCampaign.primarySponsorId) {
        return res.status(500).json({ error: 'Active campaign has no primary sponsor — invariant violation' });
      }

      const [primary, secondaryList] = await Promise.all([
        buildSponsorBlock(activeCampaign.primarySponsorId),
        storage.listSecondarySponsors(activeCampaign.id),
      ]);
      const secondarySponsors = await Promise.all(secondaryList.map(s => buildSponsorBlock(s.id)));

      const forwardedProto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
      const effectiveProtocol = forwardedProto || req.protocol;
      const wsProtocol = effectiveProtocol === 'https' ? 'wss' : 'ws';
      const wsBase = `${wsProtocol}://${req.get('host')}`;
      const commerceGraphQL = process.env.COMMERCE_GRAPHQL_PUBLIC_URL || 'https://graph-ql-dev.vio.live';

      return res.json({
        endpoints: {
          webSocketBase: wsBase,
          commerceGraphQL,
        },
        campaign: {
          id: activeCampaign.id,
          name: activeCampaign.name,
          logo: (activeCampaign as any).logo ?? null,
          isActive: (!activeCampaign.startDate || new Date(activeCampaign.startDate) <= now) &&
                    (!activeCampaign.endDate || new Date(activeCampaign.endDate) >= now) &&
                    activeCampaign.isPaused !== 'true',
          isPaused: activeCampaign.isPaused === 'true',
          startDate: activeCampaign.startDate ?? null,
          endDate: activeCampaign.endDate ?? null,
        },
        primarySponsor: primary,
        secondarySponsors: secondarySponsors.filter(Boolean),
        features: {
          shoppable: !!primary?.commerce,
          lineup: !!(activeCampaign as any).showLineup,
        },
      });
    } catch (error) {
      console.error('[v2 config] error', error);
      res.status(500).json({ error: 'Failed to build config' });
    }
  });

  // ============================================================
  // POST /v2/mobile/components/manifest — SDK location declaration
  // ============================================================
  // The partner SDK uploads at app boot **only the slot locations** its
  // layout exposes (e.g. "home_top", "match_pre_kickoff"). The dashboard's
  // "Add from library" form reads from these so an operator can never bind
  // an `app_placement` to a slot the dev's code doesn't actually render to.
  //
  // Decision (sprint 2026-04-27 PM):
  //   - **Sync semantics**: locations not in the new payload get
  //     `deprecated_at = now()`. Re-uploading clears the deprecated flag.
  //   - Manifest does NOT create `app_placements` (those are created via
  //     dashboard `/apps/:id` "Add from library" form). The SDK only owns
  //     the slot manifest.
  //   - **No legacy support**: `placements[]` and `components[]` arrays are
  //     rejected with HTTP 400. Callers must update to v2 manifest.
  //
  // Auth: `validateApiKey` resolves the `client_app_id` from the SDK's
  // `X-API-Key` header. Multi-tenant isolation by construction.
  app.post('/v2/mobile/components/manifest', validateApiKey, async (req, res) => {
    try {
      const clientApp = (req as any).clientApp;
      const body = req.body ?? {};

      // Reject legacy v1/v2 fields explicitly so partners hit a hard error
      // instead of silent no-op while the contract is still in flux.
      if ('components' in body || 'placements' in body) {
        return res.status(400).json({
          error: 'Manifest only accepts `locations[]`. The legacy `components[]` and `placements[]` arrays were retired in the dashboard-driven placement model — placements are now created via the dashboard `/apps/:id` "Add from library" form. See docs/TASK_PLACEMENTS.md.',
        });
      }

      const declaredLocations = body.locations;
      if (!Array.isArray(declaredLocations)) {
        return res.status(400).json({ error: 'Body must include `locations` array' });
      }

      const persistedLocations: any[] = [];
      const warnings: { kind: string; detail: string }[] = [];
      const seenLocationIds: string[] = [];

      for (const entry of declaredLocations) {
        if (!entry || typeof entry !== 'object') {
          warnings.push({ kind: 'invalid_location_entry', detail: 'Entry must be an object with `id`' });
          continue;
        }
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!id) {
          warnings.push({ kind: 'missing_location_id', detail: 'Location entry missing `id` string' });
          continue;
        }
        if (id.length > 100) {
          warnings.push({ kind: 'location_id_too_long', detail: `Location id '${id}' exceeds 100 chars; ignored.` });
          continue;
        }
        if (seenLocationIds.includes(id)) {
          warnings.push({ kind: 'duplicate_location_in_manifest', detail: `Location '${id}' declared more than once in this manifest; keeping first.` });
          continue;
        }
        const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() !== ''
          ? entry.displayName.trim().slice(0, 255)
          : null;
        const row = await storage.upsertAppComponentLocation(clientApp.id, id, displayName);
        seenLocationIds.push(id);
        persistedLocations.push({
          id: row.id,
          locationId: row.locationId,
          displayName: row.displayName,
        });
      }

      // Sync semantics: locations not in this payload get deprecated.
      // Idempotent — already-deprecated rows stay deprecated; re-uploaded
      // ones get their `deprecated_at` cleared by the upsert above.
      const deprecatedCount = await storage.deprecateAppComponentLocationsNotIn(clientApp.id, seenLocationIds);

      console.log(
        `[ManifestRegistry] clientApp=${clientApp.id} locations=${persistedLocations.length} deprecated=${deprecatedCount} warnings=${warnings.length}`
      );

      res.json({
        clientAppId: clientApp.id,
        locations: persistedLocations,
        deprecatedCount,
        warnings,
      });
    } catch (error) {
      console.error('[ManifestRegistry] error', error);
      res.status(500).json({ error: 'Failed to process manifest' });
    }
  });

  // GET /v2/sdk/broadcasts/:broadcastId/capabilities — per-broadcast feature flags
  app.get('/v2/mobile/broadcasts/:broadcastId/capabilities', validateApiKey, async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
      const [pollCount, contestCount, activationCount] = await Promise.all([
        db.select({ n: sql<number>`count(*)::int` }).from(polls).where(eq(polls.broadcastId, broadcastId)),
        db.select({ n: sql<number>`count(*)::int` }).from(contests).where(eq(contests.broadcastId, broadcastId)),
        db.select({ n: sql<number>`count(*)::int` }).from(shoppableAdActivations).where(eq(shoppableAdActivations.broadcastId, broadcastId)),
      ]);
      const hasPolls = pollCount[0].n > 0;
      const hasContests = contestCount[0].n > 0;
      const hasShoppable = activationCount[0].n > 0;
      res.json({
        broadcastId,
        campaignId: broadcast.campaignId,
        engagement: {
          enabled: broadcast.engagementEnabled === true,
          hasPolls,
          hasContests,
        },
        shoppable: { enabled: hasShoppable || broadcast.engagementEnabled === true },
        lineup: { available: broadcast.showLineup === true },
      });
    } catch (error) {
      console.error('[v2 capabilities] error', error);
      res.status(500).json({ error: 'Failed to fetch capabilities' });
    }
  });

  // GET /v2/sdk/broadcasts/:broadcastId/components — component placements for this broadcast
  // Merges campaign-scoped (broadcast_id IS NULL) + broadcast-scoped (broadcast_id = this)
  /**
   * Campaign-level placement components for the SDK.
   *
   * Returns the active `campaign_components` rows for a campaign that are
   * **not** scoped to a specific broadcast (i.e. `broadcast_id IS NULL`),
   * with sponsor + commerce + customConfig flattened. Mirrors the shape of
   * the broadcast-scoped endpoint below so the SDK can use the same decoder.
   *
   * Used by CampaignManager after discoverCampaigns to populate
   * `activeComponents` on cold start — without this, a fresh app install
   * sees no placements until a `component_status_changed` WS event arrives.
   */
  app.get('/v2/mobile/campaigns/:campaignId/components', validateApiKey, async (req, res) => {
    try {
      const campaignId = parseInt(req.params.campaignId);
      if (Number.isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaignId' });
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      // Post-migration 0004: campaign_components → app_placements → components.
      // Filter rules:
      //   - status = 'active'
      //   - broadcast_id IS NULL (campaign-wide, not broadcast-scoped)
      //   - app_placements.deprecated_at IS NULL — operator soft-deleted
      //     placements stop rendering; existing campaign_components keep
      //     existing in DB but the SDK is shielded from them.
      const rows = await db.select({
        cc: campaignComponents,
        ap: appPlacements,
        comp: components,
        sp: sponsors,
      })
        .from(campaignComponents)
        .innerJoin(appPlacements, eq(campaignComponents.appPlacementId, appPlacements.id))
        .innerJoin(components, eq(appPlacements.componentId, components.id))
        .innerJoin(sponsors, eq(campaignComponents.sponsorId, sponsors.id))
        .where(and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.status, 'active'),
          isNull(campaignComponents.broadcastId),
          isNull(appPlacements.deprecatedAt),
        ));

      // Response shape kept stable for iOS — `id` = template uuid (so the
      // SDK's getActiveComponent(componentId:) keeps working with the
      // template id), `locationId` sourced from app_placements (no longer
      // on campaign_components post-migration). The new `appPlacementId`
      // field exposes the FK so future SDK features can echo it back.
      // Config: template baseline merged with operator's customConfig
      // overlay (productIds, etc.).
      const items = rows.map(({ cc, ap, comp, sp }) => {
        const templateConfig = (comp as any).config ?? {};
        const overlayConfig = cc.customConfig ?? {};
        const mergedConfig =
          typeof templateConfig === 'object' && typeof overlayConfig === 'object'
            ? { ...templateConfig, ...overlayConfig }
            : (overlayConfig || templateConfig);
        return {
          id: comp.id,                                  // template id (uuid string)
          campaignComponentId: cc.id,                   // instance id (numeric)
          appPlacementId: ap.id,                        // FK to app_placements
          appPlacementName: ap.name,                    // human-friendly label ("Carrusel home")
          type: comp.type,
          name: cc.instanceName ?? ap.name,
          status: cc.status,
          locationId: ap.locationId,                    // sourced from app_placements
          sponsorId: sp.id,
          sponsor: {
            id: sp.id,
            name: sp.name,
            // logoUrl is the wide / vector brand asset (often SVG which
            // SwiftUI's AsyncImage can't decode). Pair it with the
            // raster avatarUrl so SDK clients prefer the raster for
            // inline UI rendering.
            logoUrl: sp.logoUrl ?? null,
            avatarUrl: sp.avatarUrl ?? null,
            primaryColor: sp.primaryColor ?? null,
          },
          commerce: sp.commerceApiKey ? {
            apiKey: sp.commerceApiKey,
            channelId: sp.commerceChannelId ?? null,
          } : null,
          config: mergedConfig,
        };
      });

      res.json({ campaignId, components: items });
    } catch (error) {
      console.error('[v2 campaign-components] error', error);
      res.status(500).json({ error: 'Failed to fetch campaign components' });
    }
  });

  // Broadcast-scoped placements (campaign-wide + broadcast-overridden,
  // merged). Same JOIN-through-app_placements path as the campaign-scoped
  // endpoint. Filters out deprecated placements so the SDK never sees
  // stale slots after operator soft-delete.
  app.get('/v2/mobile/broadcasts/:broadcastId/components', validateApiKey, async (req, res) => {
    try {
      const { broadcastId } = req.params;
      const broadcast = await storage.getBroadcast(broadcastId);
      if (!broadcast || !broadcast.campaignId) return res.status(404).json({ error: 'Broadcast not found' });

      const rows = await db.select({
        cc: campaignComponents,
        ap: appPlacements,
        comp: components,
        sp: sponsors,
      })
        .from(campaignComponents)
        .innerJoin(appPlacements, eq(campaignComponents.appPlacementId, appPlacements.id))
        .innerJoin(components, eq(appPlacements.componentId, components.id))
        .innerJoin(sponsors, eq(campaignComponents.sponsorId, sponsors.id))
        .where(and(
          eq(campaignComponents.campaignId, broadcast.campaignId),
          eq(campaignComponents.status, 'active'),
          isNull(appPlacements.deprecatedAt),
          or(isNull(campaignComponents.broadcastId), eq(campaignComponents.broadcastId, broadcastId)),
        ));

      const items = rows.map(({ cc, ap, comp, sp }) => ({
        id: cc.id,
        campaignComponentId: cc.id,
        appPlacementId: ap.id,
        appPlacementName: ap.name,
        type: comp.type,
        locationId: ap.locationId,
        instanceName: cc.instanceName ?? null,
        sponsor: {
          id: sp.id,
          name: sp.name,
          logoUrl: sp.logoUrl ?? null,
          avatarUrl: sp.avatarUrl ?? null,
          primaryColor: sp.primaryColor ?? null,
        },
        commerce: sp.commerceApiKey ? {
          apiKey: sp.commerceApiKey,
          channelId: sp.commerceChannelId ?? null,
        } : null,
        config: cc.customConfig ?? (comp as any).config ?? {},
      }));

      res.json({ broadcastId, components: items });
    } catch (error) {
      console.error('[v2 components] error', error);
      res.status(500).json({ error: 'Failed to fetch components' });
    }
  });

  // POST /api/sdk/tv/session/start — register / renew a TV session
  app.post('/v2/tv/session/start', validateApiKey, async (req, res) => {
    try {
      const clientApp = (req as any).clientApp;
      const { externalUserId, tvDeviceId, platform } = req.body ?? {};
      if (!externalUserId) return res.status(400).json({ error: 'externalUserId is required' });
      if (!platform) return res.status(400).json({ error: 'platform is required' });
      const tvPlatforms = ['apple-tv', 'android-tv', 'fire-tv', 'roku'];
      if (!tvPlatforms.includes(platform)) return res.status(400).json({ error: `platform must be one of ${tvPlatforms.join(', ')}` });

      const endUser = await storage.ensureEndUser(clientApp.id, String(externalUserId));
      const session = await storage.upsertTvSession({
        clientAppId: clientApp.id,
        endUserId: endUser.id,
        platform,
        tvDeviceId: tvDeviceId ?? null,
      });

      const tvEnabled = (clientApp as any).tvEnabled === true;
      const platforms: string[] = (clientApp as any).tvPlatforms ?? [];
      const platformAllowed = platforms.length === 0 ? true : platforms.includes(platform);

      res.json({
        sessionId: session.id,
        endUserId: endUser.id,
        capabilities: {
          shoppable: tvEnabled && platformAllowed,
        },
      });
    } catch (error) {
      console.error('[tv session start] error', error);
      res.status(500).json({ error: 'Failed to start TV session' });
    }
  });

  // POST /api/sdk/tv/session/heartbeat — keep the session alive
  app.post('/v2/tv/session/heartbeat', validateApiKey, async (req, res) => {
    try {
      const { sessionId } = req.body ?? {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      await storage.touchTvSession(Number(sessionId));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update TV session' });
    }
  });

  // POST /api/sdk/tv/session/end — explicit session close
  app.post('/v2/tv/session/end', validateApiKey, async (req, res) => {
    try {
      const { sessionId } = req.body ?? {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      await storage.endTvSession(Number(sessionId));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to end TV session' });
    }
  });

  // POST /api/sdk/tv/cart-intent — TV-originated cart intent with attribution
  // Persists a cart_intents row AND forwards the envelope to the user's mobile
  // via the same delivery path as /api/campaigns/:id/cart-intent (local WS →
  // Redis cluster → partner webhook / APNs). Accepts `activationId` to close
  // the attribution chain (shoppable_ad.activationId → cart_intents.source_activation_id).
  app.post('/v2/tv/cart-intent', validateApiKey, async (req, res) => {
    try {
      const clientApp = (req as any).clientApp;
      let { externalUserId, productId, campaignId, activationId, sponsorId } = req.body ?? {};
      if (!externalUserId) return res.status(400).json({ error: 'externalUserId is required' });
      if (!productId) return res.status(400).json({ error: 'productId is required' });

      // v2 minimal body: when `activationId` is supplied, resolve campaignId +
      // sponsorId from the shoppable_ad_activations row. Lets the SDK send only
      // `{ externalUserId, productId, activationId }` and the backend infer the
      // rest from the dispatch that originated the cart-intent. Fallbacks to
      // explicit `campaignId` / `sponsorId` when the caller has no activation
      // (ad-hoc triggers, legacy callers, etc.).
      if (activationId && (!campaignId || !sponsorId)) {
        const activation = await storage.getShoppableAdActivation(Number(activationId));
        if (!activation) {
          return res.status(404).json({ error: `activationId ${activationId} not found`, code: 'ACTIVATION_NOT_FOUND' });
        }
        if (activation.clientAppId && activation.clientAppId !== clientApp.id) {
          return res.status(403).json({ error: 'Activation does not belong to this API key', code: 'ACTIVATION_WRONG_CLIENT_APP' });
        }
        if (!campaignId) campaignId = activation.campaignId;
        if (!sponsorId && activation.sponsorId) sponsorId = activation.sponsorId;
      }

      if (!campaignId) return res.status(400).json({ error: 'campaignId is required (or pass activationId so it can be derived)' });

      const endUser = await storage.ensureEndUser(clientApp.id, String(externalUserId));
      const campaign = await storage.getCampaign(Number(campaignId));
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
      if (campaign.clientAppId !== clientApp.id) {
        return res.status(403).json({ error: 'Campaign does not belong to this API key' });
      }

      const tvSessionPlatform = req.body.platform as (string | undefined);
      const session = tvSessionPlatform
        ? await storage.getActiveTvSession(clientApp.id, endUser.id, tvSessionPlatform as any)
        : undefined;

      // 1. Resolve product name via Commerce — used in the push notif title/body.
      //    Per the v2 rule "no hardcoded apiKeys", route to the sponsor's own
      //    commerce key (`sponsors.commerce_api_key`) using the sponsorId that
      //    came in the cart-intent body or was derived from the activation.
      //    Falls back across `campaign_sponsors` when the supplied sponsorId
      //    has no key configured. If no sponsor in the campaign has a key,
      //    name resolution is skipped — the push notif keeps the
      //    `Product ${productId}` placeholder rather than crashing.
      //    (Same pattern as `/v2/commerce/products` resolver.)
      let resolvedName = `Product ${productId}`;
      let resolvedCommerceKey: string | null = null;
      if (sponsorId) {
        const sp = await storage.getSponsor(Number(sponsorId));
        if (sp?.commerceApiKey) resolvedCommerceKey = sp.commerceApiKey;
      }
      if (!resolvedCommerceKey) {
        // Fallback: iterate `[primary, ...secondaries]` for the first
        // sponsor with a commerce key. Primary first per storage convention.
        const allSponsors = await storage.getAllCampaignSponsors(campaign.id);
        for (const csp of allSponsors) {
          if (csp?.commerceApiKey) { resolvedCommerceKey = csp.commerceApiKey; break; }
        }
      }
      if (resolvedCommerceKey) {
        try {
          const gqlQuery = `{ Channel { GetProductsByIds(product_ids: [${productId}]) { id title } } }`;
          const gqlData = await fetchGraphQL(gqlQuery, resolvedCommerceKey);
          const name = gqlData?.data?.Channel?.GetProductsByIds?.[0]?.title;
          if (name) resolvedName = name;
        } catch (err) {
          console.warn('[tv cart-intent] Commerce lookup failed:', err);
        }
      } else {
        console.warn(`[tv cart-intent] No commerce key resolved for sponsorId=${sponsorId ?? '(none)'} campaignId=${campaign.id} — using placeholder "${resolvedName}" in push notif`);
      }

      // 2. Build canonical envelope. TV-path includes activation_id + sponsor_id in
      //    vio_payload so the iOS overlay can route to the correct per-sponsor commerce key.
      const envelope = buildCartIntentEnvelope({
        userId: String(externalUserId),
        campaignId: campaign.id,
        productId,
        productName: resolvedName,
        clientAppName: clientApp.name,
        activationId,
        sponsorId,
      });

      const wsEvent = {
        type: 'cart_intent',
        ...envelope,
        timestamp: new Date().toISOString(),
      };

      // 3. Route — local WS / Redis cluster / partner webhook+APNs fallback.
      const { deliveryMode, userConnected } = await routeUserEvent({
        userId: String(externalUserId),
        clientApp,
        envelope,
        wsEvent,
        campaignIdForDeviceLookup: campaign.id,
      });

      // 4. Persist cart_intents row with the actual delivery outcome.
      const row = await storage.createCartIntent({
        endUserId: endUser.id,
        campaignId: campaign.id,
        clientAppId: clientApp.id,
        tvSessionId: session?.id ?? null,
        sponsorId: sponsorId ? Number(sponsorId) : null,
        productId: String(productId),
        sourceActivationId: activationId ? Number(activationId) : null,
        sourceComponentId: null,
        deliveryMode,
        userConnected,
        envelope,
        metadata: null,
      });

      res.json({
        success: true,
        cartIntentId: row.id,
        mode: deliveryMode,
        userConnected,
        envelope,
      });
    } catch (error) {
      console.error('[UserEvent:cart_intent] tv handler error:', error);
      res.status(500).json({ error: 'Failed to record cart intent' });
    }
  });

  // ============================================================
  // POST /api/sdk/tv/broadcast/subscribe — combined TV bootstrap
  // ============================================================
  // One request that:
  //   1. Validates the host-provided broadcastId against Vio's DB for this client_app.
  //   2. Ensures the end_users row exists for (client_app, externalUserId).
  //   3. Upserts the tv_sessions row (one per clientApp+user+platform).
  //   4. Returns the campaign + primary/secondary sponsors with commerce blocks
  //      + wsUrl + capabilities. TV SDK opens the WS with wsUrl after this.
  //
  // If the broadcast is not found or not owned by this client_app, returns 200
  // with `{ subscribed: false, reason }` so the TV SDK can silently skip. This
  // avoids noisy error states on host apps that try to subscribe speculatively.
  app.post('/v2/tv/broadcast/subscribe', validateApiKey, async (req, res) => {
    try {
      const clientApp = (req as any).clientApp;
      const { broadcastId, externalUserId, platform, tvDeviceId } = req.body ?? {};
      if (!broadcastId) return res.status(400).json({ error: 'broadcastId is required' });
      if (!externalUserId) return res.status(400).json({ error: 'externalUserId is required' });
      if (!platform) return res.status(400).json({ error: 'platform is required' });
      const tvPlatforms = ['apple-tv', 'android-tv', 'fire-tv', 'roku'];
      if (!tvPlatforms.includes(platform)) return res.status(400).json({ error: `platform must be one of ${tvPlatforms.join(', ')}` });

      const broadcast = await storage.getBroadcast(String(broadcastId));
      // Soft-miss: broadcast unknown OR not bound to this client_app's campaigns.
      const broadcastCampaign = broadcast?.campaignId ? await storage.getCampaign(broadcast.campaignId) : null;
      if (!broadcast || !broadcastCampaign || broadcastCampaign.clientAppId !== clientApp.id) {
        return res.json({ subscribed: false, reason: 'broadcast_not_registered_for_client_app' });
      }
      if (!broadcastCampaign.primarySponsorId) {
        return res.json({ subscribed: false, reason: 'campaign_has_no_primary_sponsor' });
      }

      // TV capabilities come from the client_app flags (tv_enabled + tv_platforms).
      const tvEnabled = (clientApp as any).tvEnabled === true;
      const platformsAllowed: string[] = (clientApp as any).tvPlatforms ?? [];
      const platformOk = platformsAllowed.length === 0 ? true : platformsAllowed.includes(platform);
      if (!tvEnabled || !platformOk) {
        return res.json({ subscribed: false, reason: 'tv_not_enabled_for_this_platform' });
      }

      const endUser = await storage.ensureEndUser(clientApp.id, String(externalUserId));
      const session = await storage.upsertTvSession({
        clientAppId: clientApp.id,
        endUserId: endUser.id,
        platform,
        tvDeviceId: tvDeviceId ?? null,
      });

      // Resolve sponsors with commerce blocks — same shape as /v2/sdk/config.
      const [primary, secondaryList] = await Promise.all([
        buildSponsorBlock(broadcastCampaign.primarySponsorId),
        storage.listSecondarySponsors(broadcastCampaign.id),
      ]);
      const secondarySponsors = await Promise.all(secondaryList.map((s) => buildSponsorBlock(s.id)));

      const forwardedProto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
      const effectiveProtocol = forwardedProto || req.protocol;
      const wsProtocol = effectiveProtocol === 'https' ? 'wss' : 'ws';
      const wsUrl = `${wsProtocol}://${req.get('host')}/ws/${broadcastCampaign.id}`;

      res.json({
        subscribed: true,
        campaignId: broadcastCampaign.id,
        broadcastId: broadcast.broadcastId,
        sessionId: session.id,
        endUserId: endUser.id,
        wsUrl,
        primarySponsor: primary,
        secondarySponsors: secondarySponsors.filter(Boolean),
        capabilities: {
          shoppable: true,
          engagement: broadcast.engagementEnabled === true,
        },
      });
    } catch (error) {
      console.error('[tv subscribe] error', error);
      res.status(500).json({ error: 'Failed to subscribe TV to broadcast' });
    }
  });

  // ---- Secondary sponsors CRUD (dashboard) ----

  // GET /api/campaigns/:id/secondary-sponsors
  app.get('/api/campaigns/:id/secondary-sponsors', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const list = await storage.listSecondarySponsors(campaignId);
      res.json({ campaignId, secondarySponsors: list });
    } catch (error) {
      res.status(500).json({ error: 'Failed to list secondary sponsors' });
    }
  });

  // POST /api/campaigns/:id/secondary-sponsors  body: { sponsorId }
  app.post('/api/campaigns/:id/secondary-sponsors', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const { sponsorId } = req.body ?? {};
      if (!sponsorId) return res.status(400).json({ error: 'sponsorId is required' });
      const sponsorIdNum = Number(sponsorId);

      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
      if (campaign.primarySponsorId === sponsorIdNum) {
        return res.status(400).json({ error: 'Sponsor is already the primary sponsor' });
      }
      const sp = await storage.getSponsor(sponsorIdNum);
      if (!sp) return res.status(404).json({ error: 'Sponsor not found' });

      await storage.addSecondarySponsor(campaignId, sponsorIdNum);
      res.status(201).json({ success: true, campaignId, sponsorId: sponsorIdNum });
    } catch (error) {
      console.error('[secondary-sponsors add] error', error);
      res.status(500).json({ error: 'Failed to add secondary sponsor' });
    }
  });

  // DELETE /api/campaigns/:id/secondary-sponsors/:sponsorId
  app.delete('/api/campaigns/:id/secondary-sponsors/:sponsorId', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      const sponsorId = parseInt(req.params.sponsorId);
      // Block if any placement / poll / contest / activation references this sponsor in this campaign
      const [[{ n: ccN }]] = [await db.select({ n: sql<number>`count(*)::int` }).from(campaignComponents)
        .where(and(eq(campaignComponents.campaignId, campaignId), eq(campaignComponents.sponsorId, sponsorId)))];
      const [[{ n: activN }]] = [await db.select({ n: sql<number>`count(*)::int` }).from(shoppableAdActivations)
        .where(and(eq(shoppableAdActivations.campaignId, campaignId), eq(shoppableAdActivations.sponsorId, sponsorId)))];
      if (ccN > 0 || activN > 0) {
        return res.status(409).json({
          error: 'Cannot remove: sponsor still referenced by components or activations',
          componentRefs: ccN,
          activationRefs: activN,
        });
      }
      await storage.removeSecondarySponsor(campaignId, sponsorId);
      res.json({ success: true });
    } catch (error) {
      console.error('[secondary-sponsors remove] error', error);
      res.status(500).json({ error: 'Failed to remove secondary sponsor' });
    }
  });

  return httpServer;
}
