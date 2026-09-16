import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Google publishes the rotating public keys that sign every Firebase ID
// token. Verification is pure crypto against these keys — no runtime call
// to Firebase and no service account needed (ADR-0007).
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  signInProvider?: string;
  /** Account-type custom claims set by Commerce at signup (best-effort). */
  claims?: { business?: boolean; channel?: boolean; brandName?: string | null };
}

declare global {
  namespace Express {
    interface Request {
      firebaseIdentity?: FirebaseIdentity;
    }
  }
}

interface FirebaseAuthOptions {
  projectId: string;
  /** Test seam — inject a local JWKS instead of fetching Google's. */
  getKey?: JWTVerifyGetKey;
}

export type IdTokenVerifier = (token: string) => Promise<FirebaseIdentity>;

export function readBearerToken(req: Pick<Request, "headers">): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

/** Pure verifier: resolves the identity or throws on any invalid token. */
export function createIdTokenVerifier({ projectId, getKey }: FirebaseAuthOptions): IdTokenVerifier {
  const keyResolver = getKey ?? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));

  return async (token) => {
    const { payload } = await jwtVerify(token, keyResolver, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
    });

    if (!payload.sub) throw new Error("Token has no subject (uid)");

    return {
      uid: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : undefined,
      signInProvider: (payload.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider,
      claims: {
        business: payload.business === true || payload.isBusiness === true,
        channel: payload.channel === true || payload.isChannel === true,
        brandName: typeof payload.brand_name === "string" ? payload.brand_name : null,
      },
    };
  };
}

export function createFirebaseAuth(options: FirebaseAuthOptions): RequestHandler {
  const verify = createIdTokenVerifier(options);

  return async function firebaseAuthHandler(req: Request, res: Response, next: NextFunction) {
    const token = readBearerToken(req);
    if (!token) {
      return res.status(401).json({ message: "Missing Authorization: Bearer <Firebase ID token>" });
    }

    try {
      req.firebaseIdentity = await verify(token);
      next();
    } catch {
      return res.status(401).json({ message: "Invalid or expired Firebase ID token" });
    }
  };
}

let defaultHandler: RequestHandler | null = null;

// Env-driven instance for app wiring. Responds 501 (not 500) when the env
// is not configured so an unconfigured deploy degrades loudly but harmlessly.
export const firebaseAuth: RequestHandler = (req, res, next) => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    return res.status(501).json({ message: "FIREBASE_PROJECT_ID is not configured on this environment" });
  }
  if (!defaultHandler) {
    defaultHandler = createFirebaseAuth({ projectId });
  }
  return defaultHandler(req, res, next);
};

let defaultVerifier: IdTokenVerifier | null = null;

// Env-driven verifier for the /api gate (webapp → vio-backend with the
// Commerce Firebase token). null when FIREBASE_PROJECT_ID is not configured.
export function envIdTokenVerifier(): IdTokenVerifier | null {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  if (!defaultVerifier) defaultVerifier = createIdTokenVerifier({ projectId });
  return defaultVerifier;
}
