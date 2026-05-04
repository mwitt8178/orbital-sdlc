# Auth (Login/Signup/Verify/Forgot/Reset) — Architecture

Run: `auth-login-001`
Persona: Engineer-Principal · Opus
Risk: High (security-critical: auth flow + production deploy)
Estimate: XL

## Bounded contexts touched

- **packages/ui** — new `auth/` module + 5 pages + `<RequireAuth>` + sign-out menu + tRPC bearer header injection.
- **No backend changes.** API GW already has `HttpJwtAuthorizer` validating audience = SPA client ID. The Lambda already extracts claims (`packages/api-lambda/src/handler.ts:extractAuth`). Existing tRPC procedures will continue to receive `tenantId/userId/email/role` from the JWT once the UI sends a Bearer token.
- **No CDK changes.** Pool + client + authorizer already provisioned by `OrbitalHub-mwitt`.

## Cognito facts (verified live)

- Pool ID: `us-east-1_R89dMIxXb` (`orbital-mwitt`)
- App client: `32k8f80j12r5u896smd4oq3g78` (`orbital-mwitt-spa`)
- Auth flows enabled: `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`. **No `USER_PASSWORD_AUTH`** → must use SRP client-side.
- Client has **no secret** → SPA-safe.
- `PreventUserExistenceErrors: ENABLED` → bad-credential errors return generic `NotAuthorizedException` (no email enumeration).
- Username = email; email is auto-verified.
- Self-signup allowed (`AllowAdminCreateUserOnly: false`) → `/signup` route enabled.
- Password policy: 12+ chars, upper + lower + digit + symbol.
- Token TTLs: id/access = 60 min, refresh = 30 days (43200 min).
- ID token (NOT access token) is what the API GW JWT authorizer validates here — the existing CDK config (`api-gw-http.ts:115` + `authorizers.ts:115` `jwtAudience: [appClientId]`) matches `aud` claim, which Cognito only sets on ID tokens. UI MUST send `idToken` as `Authorization: Bearer …`.

## Library choice

`amazon-cognito-identity-js` (~50 KB gz). Smaller than `@aws-amplify/auth` (~200 KB). Implements SRP natively. No transitive AWS SDK pulls.

## Aggregate boundary

`AuthSession` is a UI-only aggregate:
- `idToken`, `accessToken`, `refreshToken` (strings; opaque JWTs)
- `expiresAt` (epoch ms; computed from id token's `exp`)
- `email`, `userId` (`sub`), `tenantId?`, `role?` decoded from id-token claims for UI display only — server STILL re-validates every request.

Storage: `localStorage` under `orbital.auth.v1`. Documented trade-off: localStorage is XSS-vulnerable; we mitigate by (a) the existing CSP-friendly Tailwind/Vite build, (b) `PreventUserExistenceErrors`, (c) refresh-token rotation. Not using `httpOnly` cookies because the API is on a different host (`hhhfb8pid6.execute-api…`) and we already do `credentials: 'omit'`.

## Event flow

### Sign-in
1. `POST` SRP A → Cognito → `PASSWORD_VERIFIER` challenge
2. Compute SRP proof → response → Cognito returns `IdToken / AccessToken / RefreshToken`
3. Persist to `localStorage`; set in-memory `AuthContext`
4. Redirect to `from` location (default `/welcome`)

### Authed API request
- `httpBatchLink.headers()` reads current id token from session store and emits `Authorization: Bearer <id_token>`
- API GW validates JWT (sig + aud + exp + iss); Lambda extracts claims via existing `extractAuth`
- 401 from API → AuthContext clears session, navigates to `/login` (with `from` state)

### Token refresh
- On AuthContext mount + every 5 min, if `expiresAt - now < 10 min`, call `cognitoUser.refreshSession(refreshToken)` → persist new tokens.
- On 401 from API, attempt one refresh-then-retry; if still 401, sign out.

### Sign-up
1. `userPool.signUp(email, password, [{ name: 'email', value: email }, …])` →
2. Redirect to `/verify?email=…`
3. User enters 6-digit code → `cognitoUser.confirmRegistration(code)` →
4. Auto-trigger sign-in with the password held in memory only for that flow (never persisted), redirect to `/`.

### Forgot password
1. `cognitoUser.forgotPassword()` → email with code
2. `/reset-password?email=…` → form: code + new password → `confirmPassword(code, newPwd)` → redirect to `/login`

## IAM diff

None. Cognito SignUp / InitiateAuth / ForgotPassword etc. are unauthenticated public APIs against the user pool — no IAM credentials required from the browser. The existing `HttpJwtAuthorizer` already permits the SPA's tokens.

## DSQL schema diff

None.

## Blast radius

- All currently-public routes (`/welcome`, `/admin`, `/`, `/dashboard`, `/cost`, `/audit`, `/backlog`, etc.) become auth-gated.
- Anyone hitting the live URL without a session is bounced to `/login`.
- The existing `welcome` page is gated behind `<RequireAuth>` like all other routes.
- The "another agent removing demo flow from welcome" is concurrent — we do NOT touch `packages/ui/src/welcome/` (doesn't exist; the file is `pages/Welcome.tsx`) and do NOT modify `Welcome.tsx`. We only wrap the `<Route>` in `<RequireAuth>` in `App.tsx`.
- All public routes whitelist: `/login`, `/signup`, `/verify`, `/forgot-password`, `/reset-password`. Everything else requires auth.

## Rollback strategy

Pure UI change. Rollback = redeploy the prior `dist/` (S3 has versioning? confirm in deploy step) OR `git revert` and redeploy. CloudFront invalidation completes in ~3 min. **No data migration, no Cognito config change, no backend redeploy.**

If localStorage shape ever needs to change, bump the storage key from `orbital.auth.v1` → `orbital.auth.v2`; old sessions silently log out (acceptable, security-positive).

## Files to create

```
packages/ui/src/auth/cognito.ts          # CognitoUserPool singleton, low-level helpers
packages/ui/src/auth/AuthContext.tsx     # provider + useAuth hook
packages/ui/src/auth/RequireAuth.tsx     # route guard
packages/ui/src/auth/storage.ts          # localStorage shim with safe parse
packages/ui/src/auth/passwordRules.ts    # zod schema matching pool policy
packages/ui/src/pages/Login.tsx
packages/ui/src/pages/Signup.tsx
packages/ui/src/pages/Verify.tsx
packages/ui/src/pages/ForgotPassword.tsx
packages/ui/src/pages/ResetPassword.tsx
packages/ui/src/components/layout/UserMenu.tsx   # avatar + sign-out dropdown
```

## Files to modify

```
packages/ui/package.json                 # add amazon-cognito-identity-js
packages/ui/.env.production              # VITE_COGNITO_USER_POOL_ID + CLIENT_ID
packages/ui/src/App.tsx                  # add 5 public routes + AuthProvider + RequireAuth wrap
packages/ui/src/services/trpc.ts         # inject Authorization header in headers() + 401 hook
packages/ui/src/components/layout/TopBar.tsx  # replace static MW avatar with <UserMenu/>
```

## Out of scope

- `welcome/` directory removal (other agent owns)
- MFA (pool doesn't have it configured)
- Federated identity (pool only supports COGNITO IdP)
- Custom claims like `tenant_id` — pool has no schema attrs and no Pre-Token Generation hook. Existing API just reads `undefined` for tenantId; this PR doesn't change that. Out of scope here.

## Confidence

`confidence: 96` — all integration points verified against live AWS, library choice tested in similar SPAs, no backend changes, deploy is to a non-prod env (`mwitt`). Threshold for High = 95; we clear it.

The one residual risk: the CloudFront distribution may not have an SPA fallback (`/login` returning the React shell). Will verify during deploy step and add a 403/404 → `/index.html` rewrite if missing.
