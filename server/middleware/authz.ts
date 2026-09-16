import type { Request, Response, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { User } from "@shared/schema";
import { readBearerToken, type FirebaseIdentity, type IdTokenVerifier } from "./firebase-auth";
import { can, requiredCapabilityFor, type Role } from "./capabilities";
import { accountKind, brandNameFor, type CommerceProfileLookup } from "../services/commerce-account";

// Operator sessions (ADR-0007, F2/F3).
//
// The login page exchanges a verified Firebase ID token for a first-party
// httpOnly cookie holding a short JWT with the users.id. Every /api request
// re-reads the users row, so role changes and de-provisioning apply on the
// next request — no token revocation problem. The dashboard's existing
// fetch() calls already send credentials, so no client call-site changes.

export const SESSION_COOKIE = "vio_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

declare global {
  namespace Express {
    interface Request {
      operator?: User;
    }
  }
}

function sessionSecret(): string {
  // Same fallback routes.ts uses for its JWT_SECRET.
  return process.env.SESSION_SECRET || "default-dev-secret";
}

export function createSessionToken(operatorId: number): string {
  return jwt.sign({ operatorId }, sessionSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function readSessionOperatorId(req: Request): number | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, sessionSecret()) as { operatorId?: number };
    return typeof decoded.operatorId === "number" ? decoded.operatorId : null;
  } catch {
    return null;
  }
}

// ── Allowlist resolution ─────────────────────────────────────────────────

export interface OperatorDirectory {
  getUserByFirebaseUid(uid: string): Promise<User | undefined>;
  getUserByEmailInsensitive(email: string): Promise<User | undefined>;
  updateUser(id: number, data: Partial<{ firebaseUid: string; name: string | null }>): Promise<User | undefined>;
  createUser(data: {
    email: string | null;
    name?: string | null;
    firebaseUid: string;
    role: Role;
    reachuUserId?: string | null;
  }): Promise<User>;
}

/** What auto-provisioning needs on top of the allowlist lookups. */
export interface ProvisioningDirectory extends OperatorDirectory {
  /** User (role `sponsor`) + its sponsor row, atomically. */
  createBusinessOperator(data: {
    email: string | null;
    name: string | null;
    firebaseUid: string;
    reachuUserId: string | null;
    sponsorName: string;
  }): Promise<User>;
  /** Unclaimed sponsors (no commerce_user_uid) holding one of these channel api keys. */
  findClaimableSponsorIds(channelApiKeys: string[]): Promise<number[]>;
  /**
   * Claim an existing sponsor for this Commerce account and create its user
   * (role sponsor), atomically. null if someone else claimed it first.
   */
  createOperatorForSponsor(data: {
    email: string | null;
    name: string | null;
    firebaseUid: string;
    reachuUserId: string | null;
    sponsorId: number;
  }): Promise<User | null>;
}

function bootstrapAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Strict allowlist (owner decision 2026-06-10): a verified Firebase identity
 * only gets a session if a users row already exists for it. Match order:
 * firebase_uid, then email (linking the uid on first login). The only
 * exception is ADMIN_EMAILS — bootstrap so the first super_admin can
 * provision everyone else without touching SQL.
 *
 * Linking by email and the ADMIN_EMAILS bootstrap both require a VERIFIED
 * email (2026-09-16): Commerce signup is open, so an unverified token could
 * otherwise claim a provisioned email that has no Firebase account yet.
 */
export async function resolveAllowlistedOperator(
  dir: OperatorDirectory,
  identity: FirebaseIdentity,
): Promise<User | null> {
  const byUid = await dir.getUserByFirebaseUid(identity.uid);
  if (byUid) return byUid;

  const email = identity.email?.toLowerCase();
  if (!email || identity.emailVerified !== true) return null;

  const byEmail = await dir.getUserByEmailInsensitive(email);
  if (byEmail) {
    if (byEmail.firebaseUid && byEmail.firebaseUid !== identity.uid) {
      console.warn(`[authz] email ${email} is linked to another Firebase uid — refusing session`);
      return null;
    }
    const linked = await dir.updateUser(byEmail.id, {
      firebaseUid: identity.uid,
      name: byEmail.name ?? identity.name ?? null,
    });
    return linked ?? null;
  }

  if (bootstrapAdminEmails().includes(email)) {
    return dir.createUser({
      email,
      name: identity.name ?? null,
      firebaseUid: identity.uid,
      role: "super_admin",
    });
  }

  return null;
}

// ── Auto-provisioning from Commerce (2026-09-16) ─────────────────────────

export type ProvisionResult =
  | { operator: User; provisioned: boolean }
  | { operator: null; reason: NotProvisionedReason };

type NotProvisionedReason = "email-conflict" | "both" | "none" | "conflict" | "ambiguous-sponsor";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

/**
 * Commerce is the only place that creates accounts. Known users resolve as
 * in the allowlist; an unknown Commerce account gets its Vio user on the
 * spot — seller → `admin` (owns its surfaces), business/supplier →
 * `sponsor` + its sponsor row. Accounts that are both, or neither, are not
 * provisioned. Concurrent first calls are safe: the unique firebase_uid makes
 * the loser re-read the winner's row.
 */
export async function resolveOrProvisionOperator(
  dir: ProvisioningDirectory,
  identity: FirebaseIdentity,
  idToken: string,
  lookupProfile?: CommerceProfileLookup,
): Promise<ProvisionResult> {
  const known = await resolveAllowlistedOperator(dir, identity);
  if (known) return { operator: known, provisioned: false };

  // A row with this email that we could not link (unverified email, or
  // linked to another uid) must not get a silent duplicate.
  if (identity.email && (await dir.getUserByEmailInsensitive(identity.email.toLowerCase()))) {
    return { operator: null, reason: "email-conflict" };
  }

  const profile = lookupProfile ? await lookupProfile(idToken) : null;
  const kind = accountKind(identity, profile);
  if (kind === "both" || kind === "none") return { operator: null, reason: kind };

  const email = identity.email?.toLowerCase() ?? null;
  const name = identity.name ?? null;
  const reachuUserId = profile?.commerceUserId != null ? String(profile.commerceUserId) : null;

  try {
    if (kind === "seller") {
      const operator = await dir.createUser({ email, name, firebaseUid: identity.uid, role: "admin", reachuUserId });
      console.info(`[authz] provisioned seller uid=${identity.uid} as user ${operator.id}`);
      return { operator, provisioned: true };
    }

    // Business: a sponsor created by hand before accounts were unified may
    // already hold one of its channel keys — link to it, never duplicate.
    const keys = profile?.channelApiKeys ?? [];
    const claimable = keys.length > 0 ? await dir.findClaimableSponsorIds(keys) : [];
    if (claimable.length > 1) {
      console.warn(`[authz] uid=${identity.uid} matches sponsors ${claimable.join(",")} — not guessing`);
      return { operator: null, reason: "ambiguous-sponsor" };
    }
    if (claimable.length === 1) {
      const operator = await dir.createOperatorForSponsor({
        email, name, firebaseUid: identity.uid, reachuUserId, sponsorId: claimable[0],
      });
      if (!operator) return { operator: null, reason: "conflict" };
      console.info(`[authz] business uid=${identity.uid} claimed sponsor ${claimable[0]} as user ${operator.id}`);
      return { operator, provisioned: true };
    }

    const operator = await dir.createBusinessOperator({
      email,
      name,
      firebaseUid: identity.uid,
      reachuUserId,
      sponsorName: brandNameFor(identity, profile),
    });
    console.info(`[authz] provisioned business uid=${identity.uid} as user ${operator.id} (new sponsor ${operator.sponsorId})`);
    return { operator, provisioned: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await dir.getUserByFirebaseUid(identity.uid);
    if (winner) return { operator: winner, provisioned: false };
    console.warn(`[authz] provisioning conflict for uid=${identity.uid}:`, (err as Error).message);
    return { operator: null, reason: "conflict" };
  }
}

const NOT_PROVISIONED_MESSAGE: Record<NotProvisionedReason, string> = {
  "email-conflict": "This email is already registered in Vio under another login — contact support",
  both: "This Commerce account is both a seller and a business — contact support",
  none: "Only Commerce sellers and businesses can use Vio",
  conflict: "Account could not be provisioned — contact support",
  "ambiguous-sponsor": "Your channels match more than one Vio brand — contact support",
};

// ── Route policy ─────────────────────────────────────────────────────────

// End-user/demo surface that must stay reachable without an operator
// session (campaign-viewer public page, SDK token bootstrap, health).
const PUBLIC_API: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/api\/status$/ },
  { method: "POST", pattern: /^\/api\/auth\/token$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+$/ },
  { method: "GET", pattern: /^\/api\/events\/\d+$/ },
  // apiKey-authenticated SDK/external endpoints that happen to live under
  // /api. They carry their own apiKey auth (validateApiKey / getSponsorsByApiKey),
  // so they must bypass the OPERATOR session gate, not require a session.
  { method: "POST", pattern: /^\/api\/campaign\/payments\/apikey\/.+$/ },
];

export function isPublicApiPath(method: string, path: string): boolean {
  return PUBLIC_API.some((rule) => rule.method === method && rule.pattern.test(path));
}

// ── The /api gate ────────────────────────────────────────────────────────

export interface ApiGateOptions {
  loadOperator: (id: number) => Promise<User | undefined>;
  /**
   * Stateless path for the Commerce webapp (a different origin, no cookie):
   * `Authorization: Bearer <Firebase ID token>` resolved through the same
   * strict allowlist as the session login. Omitted → cookie only.
   */
  bearer?: {
    verify: IdTokenVerifier;
    directory: OperatorDirectory;
    /** Create unknown Commerce accounts on the spot (needs a ProvisioningDirectory). */
    autoProvision?: { directory: ProvisioningDirectory; lookupProfile?: CommerceProfileLookup };
  };
}

export type OperatorResolution =
  | { ok: true; operator: User; via: "session" | "bearer" }
  | { ok: false; status: 401 | 403; message: string; clearCookie?: boolean };

/**
 * Who is calling: the session cookie wins; otherwise a Firebase bearer
 * token. Shared by the /api gate and GET /api/auth/me so both paths answer
 * the same way.
 */
export async function resolveRequestOperator(req: Request, opts: ApiGateOptions): Promise<OperatorResolution> {
  const operatorId = readSessionOperatorId(req);
  if (operatorId) {
    const operator = await opts.loadOperator(operatorId);
    if (!operator) return { ok: false, status: 401, message: "Session no longer valid", clearCookie: true };
    return { ok: true, operator, via: "session" };
  }

  const token = opts.bearer ? readBearerToken(req) : null;
  if (opts.bearer && token) {
    let identity: FirebaseIdentity;
    try {
      identity = await opts.bearer.verify(token);
    } catch {
      return { ok: false, status: 401, message: "Invalid or expired Firebase ID token" };
    }
    const auto = opts.bearer.autoProvision;
    if (auto) {
      const result = await resolveOrProvisionOperator(auto.directory, identity, token, auto.lookupProfile);
      if (!result.operator) return { ok: false, status: 403, message: NOT_PROVISIONED_MESSAGE[result.reason] };
      return { ok: true, operator: result.operator, via: "bearer" };
    }
    const operator = await resolveAllowlistedOperator(opts.bearer.directory, identity);
    if (!operator) return { ok: false, status: 403, message: "Account is not provisioned for this dashboard" };
    return { ok: true, operator, via: "bearer" };
  }

  return { ok: false, status: 401, message: "Authentication required" };
}

export function createApiGate(opts: ApiGateOptions): RequestHandler {
  return async (req, res, next) => {
    // Mounted at app.use('/api', …): req.path lacks the mount prefix.
    const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, "") || req.baseUrl;
    const method = req.method.toUpperCase();

    if (isPublicApiPath(method, path)) return next();

    const resolved = await resolveRequestOperator(req, opts);
    if (!resolved.ok) {
      if (resolved.clearCookie) clearSessionCookie(res);
      return res.status(resolved.status).json({ message: resolved.message });
    }
    const { operator } = resolved;

    const required = requiredCapabilityFor(method, path);
    if (!can(operator.role, required)) {
      return res.status(403).json({ message: `Your role (${operator.role}) lacks capability: ${required}` });
    }

    req.operator = operator;
    next();
  };
}
