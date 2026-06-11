# Auth & Permissions (operators)

> **Scope**: how dashboard **operators** authenticate and what each role can do.
> This is the implementation reference for ADR-0007. The high-level decision
> record lives in the handbook (`vio-handbook/docs/decisions/0007-firebase-auth-single-idp.md`);
> this doc is the detailed, code-level truth for the backend.
>
> **Not in scope**: SDK/end-user auth (apiKey + `/v2`,`/v1`) — that's a separate
> layer, see [`API_V2_CONTRACT.md`](./API_V2_CONTRACT.md). The two never mix
> (see §7).
>
> **Status**: F1–F3 implemented on branch `feature/firebase-auth-users-roles`
> (PR #41 on socket-server) + ADR PR #4 on vio-handbook. Last updated 2026-06-10.

---

## 1. The model in one paragraph

Operators sign in with the **shared Vio Commerce Firebase project** (one identity
pool for both products). The backend **verifies** the Firebase ID token offline
(Google JWKS — no service account, no call to Commerce) and exchanges it for a
first-party **httpOnly session cookie**. Every `/api` request then passes through
one gate that asks two independent questions: **(1) does this role have the
capability this route needs?** and **(2) which tenant's data may it touch?**
`super_admin` is global; `admin` is a tenant root that owns its apps + sponsors;
`operator`/`viewer` belong to an admin's tenant.

---

## 2. Two axes — capabilities × tenancy

Authorization is **not** a linear hierarchy. It is two orthogonal axes:

- **Capability** — *what kind of action* (e.g. `apps:create`, `campaigns:read`).
  Defined per role in [`server/middleware/capabilities.ts`](../server/middleware/capabilities.ts).
- **Tenancy / owner scope** — *on whose data*. Resolved by `ownerScope()` in the
  same file, using `users.role` + `users.parent_admin_id`.

A request is allowed only if the role **has the capability** AND the target row
is **in the operator's owner scope**.

---

## 3. Roles & capability matrix (v1)

Source of truth: `ROLE_CAPABILITIES` in `capabilities.ts`.

| Capability | Covers | super_admin | admin | operator | viewer |
|---|---|:--:|:--:|:--:|:--:|
| `apps:read` | `GET /api/client-apps*` | ✓ | ✓ | ✓ | |
| `apps:create` | `POST /api/client-apps` | ✓ | ✓ | | |
| `apps:write` | edit/delete apps, channels, placements | ✓ | ✓ | | |
| `sponsors:read` | `GET /api/sponsors*` | ✓ | ✓ | | ✓ |
| `sponsors:write` | create/edit sponsors | ✓ | ✓ | | |
| `campaigns:read` | `GET /api/campaigns*` | ✓ | ✓ | ✓ | |
| `campaigns:create` | `POST /api/campaigns` | ✓ | ✓ | ✓ | |
| `campaigns:write` | edit campaigns / broadcasts / components / events | ✓ | ✓ | | |
| `users:manage` | `/api/auth/users*` (operator allowlist) | ✓ | | | |

In words:
- **super_admin** — everything, global. (Vio team. Today: `angelo@tipio.no`.)
- **admin** — owns and manages its tenant: its apps, its sponsors, and the
  campaigns under them. Cannot manage operators. Sees only its own data.
- **operator** — *v1 deliberately minimal*: can only **create campaigns** and read
  what it needs (its admin's apps + campaigns). Cannot create apps/sponsors, and
  cannot yet edit existing campaign content.
- **viewer** — read-only, sponsor-facing. v1: `sponsors:read` only.

### Route → capability mapping

`requiredCapabilityFor(method, path)` in `capabilities.ts`:

| Path prefix | GET | POST (exact collection) | other mutations |
|---|---|---|---|
| `/api/auth/users*`, `/api/users*` | `users:manage` | `users:manage` | `users:manage` |
| `/api/client-apps*` | `apps:read` | `apps:create` (`POST /api/client-apps`) | `apps:write` |
| `/api/sponsors*` | `sponsors:read` | `sponsors:write` | `sponsors:write` |
| `/api/campaigns*` | `campaigns:read` | `campaigns:create` (`POST /api/campaigns`) | `campaigns:write` |
| **everything else under `/api`** | `campaigns:read` | `campaigns:write` | `campaigns:write` |

The fallback (last row) keeps the long tail of dashboard routes (broadcasts,
components, polls, events, sportmonks, …) at **admin+** until we classify them
individually. Consequence: `operator`/`viewer` get 403 on those by default —
intentional for v1.

---

## 4. Tenancy (owner scope)

Ownership already lived on the data (`client_apps.user_id`, `sponsors.user_id`,
`campaigns.user_id`). Tenancy adds the operator→tenant link.

- **admin = tenant root.** It owns its `client_apps` and `sponsors` (their
  `user_id` = the admin's id). A campaign created in the tenant gets the same
  `user_id`.
- **operator / viewer belong to an admin** via `users.parent_admin_id`
  (migration 0008). They operate inside that admin's apps/sponsors — never
  another tenant's.
- **super_admin** has no tenant (`parent_admin_id` null) and sees everything.

`ownerScope(operator)` returns:

| Role | Scope |
|---|---|
| super_admin | `{ all: true }` → no filter |
| admin | `{ ownerId: <own id> }` |
| operator / viewer | `{ ownerId: <parent_admin_id> }` (falls back to own id if null) |

**Owner-on-create** (`createOwnerId` in `routes.ts`): a new app/sponsor/campaign
is owned by the creator's tenant. `super_admin` may target a specific admin by
passing `userId` in the body (that's how it assigns); everyone else is forced to
their own tenant owner — a client cannot create rows on another tenant's behalf.

---

## 5. The `/api` gate

Mounted once: `app.use('/api', createApiGate(...))` in `routes.ts`. Per request:

1. **Public?** If `(method, path)` is in `PUBLIC_API` → pass through (no session).
2. **Session?** Read the `vio_session` cookie → verify JWT → `operatorId`.
   No/invalid cookie → **401**.
3. **Operator still exists?** Load the `users` row by id (re-read **every**
   request, so role changes / de-provisioning apply on the next call). Gone →
   clear cookie + **401**.
4. **Capability?** `can(operator.role, requiredCapabilityFor(method, path))`.
   Missing → **403**.
5. Attach `req.operator` and continue. **Owner-scope filtering happens in the
   route handlers** (§4), not in the gate.

`/api/auth/session` (POST/DELETE) and `/api/auth/me` are registered **before**
the gate, so they are not subject to it.

---

## 6. What's reachable without an operator session (`PUBLIC_API`)

Defined in `authz.ts`. Two groups:

**End-user / dashboard-public surface**
- `GET /api/status` — health.
- `GET /api/campaigns/:id`, `GET /api/events/:id` — the public campaign-viewer page.

**apiKey-authenticated SDK/external endpoints that happen to live under `/api`**
- `POST /api/auth/token` — apiKey → JWT (SDK bootstrap).
- `POST /api/checkout/confirm-apple-pay` — iOS SDK Apple Pay confirm (`validateApiKey`).
- `POST /api/campaign/payments/apikey/:apiKey` — sponsor payment-method sync (apiKey in path).

These carry their **own apiKey auth**; they bypass the *operator* gate, not all
auth. (Regression history: the gate originally shadowed the last two → 401 before
their apiKey check could run; fixed by listing them here. See §7.)

---

## 7. apiKey layer vs operator layer — they don't mix

- The **operator** gate is `app.use('/api', …)` — it only touches `/api/*`.
- The **SDK/apiKey** surface lives under **`/v2/*`** and **`/v1/*`** (auth via the
  `validateApiKey` middleware, `x-api-key` header or `?apiKey=`). Those prefixes
  are **never** behind the operator gate.
- The only overlap is the three apiKey endpoints that historically sit under
  `/api` (§6) — explicitly exempted.

So: changing operator auth cannot break SDK apiKey flows, and vice-versa. Verified
2026-06-10 (`/v2/mobile/config`, `/api/auth/token`, both apiKey endpoints).

---

## 8. Session mechanism

1. Login page (`client/src/pages/login.tsx`) signs in with Firebase (email/password
   or Google) against the shared project → gets a Firebase **ID token**.
2. `POST /api/auth/session` with `Authorization: Bearer <idToken>`. The
   `firebaseAuth` middleware (`firebase-auth.ts`) verifies it (RS256 vs Google
   JWKS, issuer/audience bound to `FIREBASE_PROJECT_ID`).
3. `resolveAllowlistedOperator` (§9) maps the identity to a `users` row.
4. A short JWT holding `operatorId` is set as the **httpOnly `vio_session`
   cookie** (7-day, `SameSite=Lax`, `secure` outside dev). The dashboard's
   existing `fetch()` calls already send credentials → no client call-site
   changes.
5. `DELETE /api/auth/session` clears it; `GET /api/auth/me` returns the profile.

The cookie holds **only the operator id** — role/scope are re-read from the DB
each request (no stale-permission window).

---

## 9. Allowlist (who gets a session)

`resolveAllowlistedOperator` in `authz.ts` — **strict allowlist** (owner decision,
§11 D2):

1. Match by `firebase_uid` → return that operator.
2. Else match by **email** (case-insensitive). If found, link the `firebase_uid`
   on this first login and return it. (Refuses if the email is already linked to
   a different uid.)
3. Else, if the email is in **`ADMIN_EMAILS`** (env), bootstrap a `super_admin`
   row — so the first super_admin can provision everyone without touching SQL.
4. Else → **no session** (403). No silent auto-provisioning.

A Google account that doesn't exist in the project yet is created by Google on
first sign-in; the allowlist still governs whether it gets a *dashboard* session.

---

## 10. Per-environment Firebase project

`FIREBASE_PROJECT_ID` (runtime) + `VITE_FIREBASE_*` (build-time, baked into the
bundle). One project **per environment** — never point prod at staging:

| Env | Firebase project |
|---|---|
| local / development / staging | `reachu-qa` (Commerce staging) |
| production | separate Commerce **production** project (config pending) |

Authorized domains (Firebase console) must list every origin that serves the
login page. Google OAuth needs it; email/password does not. As of 2026-06-10
`reachu-qa` authorizes `localhost` (+ reachu.io domains) but **not** any
`*.vio.live` — so Google login works on localhost, and through the tunnel
(`api-local-angelo.vio.live`) only email/password works until that domain is
added.

---

## 11. Decision log

| # | Decision | Why | Date |
|---|---|---|---|
| D1 | Commerce's Firebase is the **single cross-product IdP**; backends stay separate and verify ID tokens **offline** (JWKS). | Reuse the working IdP; zero runtime coupling between products. | 2026-06-10 |
| D2 | **Strict allowlist** — only pre-provisioned emails get a session; `ADMIN_EMAILS` bootstraps the first super_admin. | Authenticating ≠ authorizing; the dashboard must not open to the whole Commerce user pool. | 2026-06-10 |
| D3 | Roles **super_admin / admin / operator / viewer**. super_admin global; **admin = tenant root (NOT global)**; operator v1 = create campaigns only; viewer = read its sponsor. | Owner's intent for a small internal team with per-brand tenants. | 2026-06-10 |
| D4 | **Capability matrix**, not a linear role level. | "Define each role's abilities step by step" — extensible without re-plumbing. | 2026-06-10 |
| D5 | Tenancy via **`parent_admin_id`**; ownership of apps/sponsors on `user_id`. | Divide real apps (Viaplay/TV2/VG) among per-brand admins. | 2026-06-10 |
| D6 | Scope reads/writes by the **session operator**, not a client-supplied `?userId=`. | The old param let any client read any tenant's data. | 2026-06-10 |
| D7 | apiKey-authed `/api` endpoints (`confirm-apple-pay`, `payments/apikey`) **exempt** from the operator gate. | They authenticate by apiKey; the gate must not shadow them. | 2026-06-10 |
| D8 | Session = **httpOnly cookie**, role re-read per request. | Instant role change / de-provision; no client call-site changes. | 2026-06-10 |
| D9 | **Per-environment** Firebase projects; prod is separate. | Never touch prod users from staging work. | 2026-06-10 |

ADR PR/merge discipline (no auto-merge, owner merges) applies — see handbook
ADR-0001.

---

## 12. Status — done vs pending

**Implemented (PR #41)**
- Migrations: `0007` (`firebase_uid`, `role` enum, `sponsor_id`), `0008` (`parent_admin_id`).
- `capabilities.ts` (matrix + `can` + `requiredCapabilityFor` + `ownerScope`).
- `/api` gate (capability-based) + session endpoints + strict allowlist.
- Owner-scoped **list** endpoints: `client-apps`, `client-apps/with-stats`,
  `sponsors`, `campaigns`. Owner-on-create for apps/sponsors/campaigns.
- `/users` management UI (super_admin) + `/login` page + per-env Firebase config.
- Tests: `capabilities.test.ts`, `authz.test.ts`, `firebase-auth.test.ts`.

**Implemented (PR #42) — per-resource ownership guard**
- `server/middleware/resource-ownership.ts`: `createOwnershipGuard` mounted on
  `app.use('/api', …)` after the capability gate. Resolves the owning `user_id`
  for `client-apps/:id`, `campaigns/:id`, `sponsors/:id`, `events/:id` (direct)
  and `broadcasts/:broadcastId`, `polls/:id`, `contests/:id`,
  `scheduled-components/:id` (via parent chain), and 403s cross-tenant access.
  super_admin bypasses; public paths skip; missing/unknown resources fall
  through (handler 404s) so it never blocks a valid request. Tests:
  `resource-ownership.test.ts`.
- Also scoped `GET /api/broadcasts` by tenant (it was returning **all**
  broadcasts to every operator) — a broadcast belongs to a tenant via its
  campaign's owner; super_admin sees all.
- **Residual (still not ownership-checked):** `broadcasts/ads|products/:id` (no
  storage getter for the leaf) and `components/:id` (the components table is a
  **global library**, intentionally not tenant-scoped).

**Pending (next steps — paso a paso)**
- Expand **operator** capabilities (e.g. `campaigns:write` for campaigns it owns).
- **viewer** scoping to its single sponsor (`users.sponsor_id`) — today
  `sponsors:read` is tenant-level, not sponsor-level.
- UI to set `parent_admin_id` when creating operator/viewer (API already accepts it).
- Reassign/clean leftover data; confirm prod Firebase project config; add
  `*.vio.live` dashboard domains to Firebase authorized domains.

---

## 13. How to extend

- **Give a role a new ability** → add the `Capability` and list it under the role
  in `ROLE_CAPABILITIES`. One line. (e.g. operator edit-own-campaigns: add
  `"campaigns:write"` to `operator`.)
- **Add a capability for a new route group** → add a branch in
  `requiredCapabilityFor`.
- **Change who-sees-what** → adjust `ownerScope` (the tenancy axis), independent
  of capabilities.
- **Add a new public/apiKey route under `/api`** → add it to `PUBLIC_API` in
  `authz.ts` (and confirm it has its own auth).

---

## 14. File map

| Concern | File |
|---|---|
| Capability matrix, `can`, `requiredCapabilityFor`, `ownerScope` | `server/middleware/capabilities.ts` |
| Session cookie, allowlist, the `/api` gate, `PUBLIC_API` | `server/middleware/authz.ts` |
| Firebase ID-token verification (JWKS) | `server/middleware/firebase-auth.ts` |
| `users` table (`role`, `firebase_uid`, `sponsor_id`, `parent_admin_id`) | `shared/schema.ts` + migrations `0007`,`0008` |
| Session + user-management endpoints, owner-scoped lists | `server/routes.ts` (`/api/auth/*`, list handlers) |
| Login page, operator-management UI | `client/src/pages/login.tsx`, `client/src/pages/users.tsx` |
| Client session context, Firebase client config | `client/src/contexts/UserContext.tsx`, `client/src/lib/firebase.ts` |

Env vars: `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `ADMIN_EMAILS`, `SESSION_SECRET`.
