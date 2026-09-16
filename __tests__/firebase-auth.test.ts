import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createFirebaseAuth, firebaseAuth } from "../server/middleware/firebase-auth";

const PROJECT_ID = "reachu-qa";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

type TokenOptions = {
  sub?: string | null;
  iss?: string;
  aud?: string;
  exp?: string | number;
};

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("firebase-auth middleware", () => {
  let middleware: ReturnType<typeof createFirebaseAuth>;
  let signToken: (opts?: TokenOptions) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const getKey = createLocalJWKSet({
      keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }],
    });
    middleware = createFirebaseAuth({ projectId: PROJECT_ID, getKey });

    signToken = async (opts: TokenOptions = {}) => {
      const jwt = new SignJWT({
        email: "ops@vio.live",
        email_verified: true,
        name: "Ops Tester",
        firebase: { sign_in_provider: "password" },
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(opts.iss ?? ISSUER)
        .setAudience(opts.aud ?? PROJECT_ID)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? "1h");
      if (opts.sub !== null) {
        jwt.setSubject(opts.sub ?? "uid-123");
      }
      return jwt.sign(privateKey);
    };
  });

  it("rejects a request without Authorization header", async () => {
    const res = mockRes();
    const next = jest.fn();
    await middleware({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a malformed token", async () => {
    const res = mockRes();
    const next = jest.fn();
    await middleware({ headers: { authorization: "Bearer not-a-jwt" } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a valid token and exposes the identity", async () => {
    const token = await signToken();
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.firebaseIdentity).toEqual({
      uid: "uid-123",
      email: "ops@vio.live",
      emailVerified: true,
      name: "Ops Tester",
      signInProvider: "password",
      claims: { business: false, channel: false, brandName: null },
    });
  });

  it("exposes the Commerce account-type claims", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const getKey = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "claims-key" }] });
    const mw = createFirebaseAuth({ projectId: PROJECT_ID, getKey });
    const token = await new SignJWT({ email: "brand@shop.no", business: true, channel: false, brand_name: "Shop AS" })
      .setProtectedHeader({ alg: "RS256", kid: "claims-key" })
      .setIssuer(ISSUER)
      .setAudience(PROJECT_ID)
      .setSubject("uid-b")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    await mw(req, mockRes(), jest.fn());
    expect(req.firebaseIdentity.claims).toEqual({ business: true, channel: false, brandName: "Shop AS" });
  });

  it("rejects a token for another audience (project)", async () => {
    const token = await signToken({ aud: "some-other-project" });
    const res = mockRes();
    const next = jest.fn();
    await middleware({ headers: { authorization: `Bearer ${token}` } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token from another issuer", async () => {
    const token = await signToken({ iss: "https://securetoken.google.com/evil" });
    const res = mockRes();
    const next = jest.fn();
    await middleware({ headers: { authorization: `Bearer ${token}` } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = mockRes();
    const next = jest.fn();
    await middleware({ headers: { authorization: `Bearer ${token}` } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token without subject", async () => {
    const token = await signToken({ sub: null });
    const res = mockRes();
    const next = jest.fn();
    await middleware({ headers: { authorization: `Bearer ${token}` } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("firebaseAuth env-driven wrapper", () => {
  it("responds 501 when FIREBASE_PROJECT_ID is not configured", async () => {
    const previous = process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PROJECT_ID;
    try {
      const res = mockRes();
      const next = jest.fn();
      await firebaseAuth({ headers: {} } as any, res, next);
      expect(res.status).toHaveBeenCalledWith(501);
      expect(next).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.FIREBASE_PROJECT_ID = previous;
    }
  });
});
