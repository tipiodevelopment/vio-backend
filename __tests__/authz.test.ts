import type { User } from "../shared/schema";
import {
  SESSION_COOKIE,
  createApiGate,
  createSessionToken,
  isPublicApiPath,
  readSessionOperatorId,
  resolveAllowlistedOperator,
  resolveRequestOperator,
} from "../server/middleware/authz";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    reachuUserId: null,
    firebaseUid: null,
    role: "viewer",
    sponsorId: null,
    parentAdminId: null,
    email: "ops@vio.live",
    name: "Ops",
    firebaseToken: null,
    createdAt: new Date(),
    ...overrides,
  } as User;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

function reqWithSession(operatorId: number, method: string, path: string) {
  const token = createSessionToken(operatorId);
  return {
    method,
    baseUrl: "/api",
    path: path.replace(/^\/api/, ""),
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  } as any;
}

describe("public surface", () => {
  it("classifies the public end-user surface", () => {
    expect(isPublicApiPath("GET", "/api/status")).toBe(true);
    expect(isPublicApiPath("POST", "/api/auth/token")).toBe(true);
    expect(isPublicApiPath("GET", "/api/campaigns/12")).toBe(true);
    expect(isPublicApiPath("GET", "/api/events/12")).toBe(true);
    expect(isPublicApiPath("GET", "/api/campaigns")).toBe(false);
    expect(isPublicApiPath("PUT", "/api/campaigns/12")).toBe(false);
    expect(isPublicApiPath("GET", "/api/campaigns/12/stats")).toBe(false);
  });

  it("lets apiKey-authenticated SDK endpoints under /api bypass the operator gate", () => {
    expect(isPublicApiPath("POST", "/api/checkout/confirm-apple-pay")).toBe(true);
    expect(isPublicApiPath("POST", "/api/campaign/payments/apikey/some_api_key_123")).toBe(true);
    // but not the dashboard checkout/payment surface
    expect(isPublicApiPath("GET", "/api/checkout/confirm-apple-pay")).toBe(false);
    expect(isPublicApiPath("POST", "/api/campaign/payments")).toBe(false);
  });
});

describe("session token", () => {
  it("round-trips the operator id through the cookie", () => {
    const req = reqWithSession(42, "GET", "/api/campaigns");
    expect(readSessionOperatorId(req)).toBe(42);
  });

  it("rejects a tampered cookie", () => {
    const req = {
      headers: { cookie: `${SESSION_COOKIE}=not.a.token` },
    } as any;
    expect(readSessionOperatorId(req)).toBeNull();
  });
});

describe("resolveAllowlistedOperator (strict allowlist)", () => {
  const identity = { uid: "uid-1", email: "Ops@vio.live", name: "Ops" };

  it("returns the user matched by firebase uid", async () => {
    const user = fakeUser({ firebaseUid: "uid-1" });
    const dir = {
      getUserByFirebaseUid: jest.fn().mockResolvedValue(user),
      getUserByEmailInsensitive: jest.fn(),
      updateUser: jest.fn(),
      createUser: jest.fn(),
    };
    await expect(resolveAllowlistedOperator(dir, identity)).resolves.toBe(user);
  });

  it("links the uid on first login when the email is allowlisted", async () => {
    const provisioned = fakeUser({ id: 7, firebaseUid: null });
    const linked = fakeUser({ id: 7, firebaseUid: "uid-1" });
    const dir = {
      getUserByFirebaseUid: jest.fn().mockResolvedValue(undefined),
      getUserByEmailInsensitive: jest.fn().mockResolvedValue(provisioned),
      updateUser: jest.fn().mockResolvedValue(linked),
      createUser: jest.fn(),
    };
    await expect(resolveAllowlistedOperator(dir, identity)).resolves.toBe(linked);
    expect(dir.updateUser).toHaveBeenCalledWith(7, expect.objectContaining({ firebaseUid: "uid-1" }));
  });

  it("refuses when the email is already linked to another uid", async () => {
    const dir = {
      getUserByFirebaseUid: jest.fn().mockResolvedValue(undefined),
      getUserByEmailInsensitive: jest.fn().mockResolvedValue(fakeUser({ firebaseUid: "other-uid" })),
      updateUser: jest.fn(),
      createUser: jest.fn(),
    };
    await expect(resolveAllowlistedOperator(dir, identity)).resolves.toBeNull();
    expect(dir.updateUser).not.toHaveBeenCalled();
  });

  it("refuses unknown accounts (no auto-provision)", async () => {
    const dir = {
      getUserByFirebaseUid: jest.fn().mockResolvedValue(undefined),
      getUserByEmailInsensitive: jest.fn().mockResolvedValue(undefined),
      updateUser: jest.fn(),
      createUser: jest.fn(),
    };
    await expect(resolveAllowlistedOperator(dir, identity)).resolves.toBeNull();
    expect(dir.createUser).not.toHaveBeenCalled();
  });

  it("bootstraps super_admin for ADMIN_EMAILS", async () => {
    const previous = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "boss@vio.live, ops@vio.live";
    try {
      const created = fakeUser({ role: "super_admin", firebaseUid: "uid-1" });
      const dir = {
        getUserByFirebaseUid: jest.fn().mockResolvedValue(undefined),
        getUserByEmailInsensitive: jest.fn().mockResolvedValue(undefined),
        updateUser: jest.fn(),
        createUser: jest.fn().mockResolvedValue(created),
      };
      await expect(resolveAllowlistedOperator(dir, identity)).resolves.toBe(created);
      expect(dir.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: "ops@vio.live", role: "super_admin", firebaseUid: "uid-1" }),
      );
    } finally {
      if (previous === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = previous;
    }
  });
});

describe("createApiGate", () => {
  it("lets the public surface through without a session", async () => {
    const gate = createApiGate({ loadOperator: jest.fn() });
    const res = mockRes();
    const next = jest.fn();
    await gate({ method: "GET", baseUrl: "/api", path: "/campaigns/3", headers: {} } as any, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 401 without a session cookie", async () => {
    const gate = createApiGate({ loadOperator: jest.fn() });
    const res = mockRes();
    const next = jest.fn();
    await gate({ method: "GET", baseUrl: "/api", path: "/campaigns", headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 and clears the cookie when the operator row is gone", async () => {
    const gate = createApiGate({ loadOperator: jest.fn().mockResolvedValue(undefined) });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithSession(99, "GET", "/api/campaigns"), res, next);
    expect(res.clearCookie).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 403 when the role is insufficient", async () => {
    const gate = createApiGate({ loadOperator: jest.fn().mockResolvedValue(fakeUser({ role: "viewer" })) });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithSession(1, "POST", "/api/campaigns"), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches the operator and continues when authorized", async () => {
    const operator = fakeUser({ role: "operator" });
    const gate = createApiGate({ loadOperator: jest.fn().mockResolvedValue(operator) });
    const res = mockRes();
    const next = jest.fn();
    const req = reqWithSession(1, "POST", "/api/campaigns");
    await gate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.operator).toBe(operator);
  });
});

// Commerce webapp path: another origin, no cookie — the Firebase ID token
// travels as `Authorization: Bearer` and is checked against a real (local)
// JWKS so the whole verify → allowlist → capability chain runs.
describe("createApiGate — Firebase bearer (Commerce webapp)", () => {
  const PROJECT_ID = "reachu-qa";
  let verify: import("../server/middleware/firebase-auth").IdTokenVerifier;
  let signToken: (opts?: { sub?: string; aud?: string; email?: string }) => Promise<string>;

  beforeAll(async () => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import("jose");
    const { createIdTokenVerifier } = await import("../server/middleware/firebase-auth");
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const getKey = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "k1" }] });
    verify = createIdTokenVerifier({ projectId: PROJECT_ID, getKey });
    signToken = async (opts = {}) =>
      new SignJWT({ email: opts.email ?? "brand@shop.no", email_verified: true })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
        .setAudience(opts.aud ?? PROJECT_ID)
        .setSubject(opts.sub ?? "commerce-uid")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
  });

  function directory(user?: User) {
    return {
      getUserByFirebaseUid: jest.fn().mockResolvedValue(user),
      getUserByEmailInsensitive: jest.fn().mockResolvedValue(undefined),
      updateUser: jest.fn(),
      createUser: jest.fn(),
    };
  }

  function reqWithBearer(token: string, method: string, path: string, extraHeaders: Record<string, string> = {}) {
    return {
      method,
      baseUrl: "/api",
      path: path.replace(/^\/api/, ""),
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    } as any;
  }

  it("attaches the provisioned operator for a valid token", async () => {
    const operator = fakeUser({ id: 5, role: "admin", firebaseUid: "commerce-uid" });
    const gate = createApiGate({ loadOperator: jest.fn(), bearer: { verify, directory: directory(operator) } });
    const res = mockRes();
    const next = jest.fn();
    const req = reqWithBearer(await signToken(), "GET", "/api/client-apps");
    await gate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.operator).toBe(operator);
  });

  it("returns 403 for a valid token whose account is not provisioned", async () => {
    const gate = createApiGate({ loadOperator: jest.fn(), bearer: { verify, directory: directory(undefined) } });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithBearer(await signToken(), "GET", "/api/client-apps"), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a token from another Firebase project", async () => {
    const gate = createApiGate({
      loadOperator: jest.fn(),
      bearer: { verify, directory: directory(fakeUser({ role: "admin" })) },
    });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithBearer(await signToken({ aud: "some-other-project" }), "GET", "/api/client-apps"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for garbage in the bearer", async () => {
    const gate = createApiGate({ loadOperator: jest.fn(), bearer: { verify, directory: directory() } });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithBearer("not-a-jwt", "GET", "/api/client-apps"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("still enforces the role capability on the bearer path", async () => {
    const viewer = fakeUser({ role: "viewer", firebaseUid: "commerce-uid" });
    const gate = createApiGate({ loadOperator: jest.fn(), bearer: { verify, directory: directory(viewer) } });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithBearer(await signToken(), "POST", "/api/campaigns"), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores the bearer when the gate is cookie-only (not configured)", async () => {
    const dir = directory(fakeUser({ role: "admin" }));
    const gate = createApiGate({ loadOperator: jest.fn() });
    const res = mockRes();
    const next = jest.fn();
    await gate(reqWithBearer(await signToken(), "GET", "/api/client-apps"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(dir.getUserByFirebaseUid).not.toHaveBeenCalled();
  });

  it("prefers the session cookie when both are present", async () => {
    const sessionOperator = fakeUser({ id: 1, role: "admin" });
    const bearerOperator = fakeUser({ id: 2, role: "admin", firebaseUid: "commerce-uid" });
    const dir = directory(bearerOperator);
    const opts = { loadOperator: jest.fn().mockResolvedValue(sessionOperator), bearer: { verify, directory: dir } };
    const token = await signToken();
    const cookie = `${SESSION_COOKIE}=${createSessionToken(1)}`;
    const resolved = await resolveRequestOperator(reqWithBearer(token, "GET", "/api/client-apps", { cookie }), opts);
    expect(resolved).toEqual({ ok: true, operator: sessionOperator, via: "session" });
    expect(dir.getUserByFirebaseUid).not.toHaveBeenCalled();
  });

  it("reports the bearer path in resolveRequestOperator", async () => {
    const operator = fakeUser({ id: 9, role: "sponsor", firebaseUid: "commerce-uid" });
    const resolved = await resolveRequestOperator(reqWithBearer(await signToken(), "GET", "/api/auth/me"), {
      loadOperator: jest.fn(),
      bearer: { verify, directory: directory(operator) },
    });
    expect(resolved).toEqual({ ok: true, operator, via: "bearer" });
  });
});
