# Browser compatibility and integration gates

## Version and contract compatibility

| Package version                               | Customer contract | Management contract                                                           | Contract tag                                                                                  | Contract commit                                                                        |
| --------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@skyporch/daykeeper-web` 0.2.0 (unreleased)  | 0.1.0             | not consumed (gateway management contract 0.2.0 is unrelated to this package) | none yet — snapshot is an untagged commit; a released tag must be recorded before publication | `4a2b82c9b23503073dc26fdeb5163e8869d007b8` (`SkyPorch/daykeeper-openapi`, PR #13 head) |
| `@skyporch/daykeeper-web` 0.1.0 (unpublished) | 0.1.0             | not consumed                                                                  | `v1.0.0`                                                                                      | `35f5bd45fe0c6a6901766543bff90dae6838b965`                                             |

This package vendors the **customer** contract (`openapi/customer.yaml`), which
is still at 0.1.0. The `Idempotency-Key` request header that becomes REQUIRED on
flow mutations in the **management** contract 0.2.0, and the `200` returned
alongside `201` for a replayed mutation, belong to that management contract
only. Neither applies here: the customer contract defines no such header and no
such replay response, and `daykeeper-web` sends no management requests. The
0.2.0 version of this package is driven by its own breaking change, described in
`CHANGELOG.md`.

Per `SkyPorch/daykeeper-openapi` `VERSIONING.md`, contract releases are
immutable `vMAJOR.MINOR.PATCH` tags and every SDK release must record the exact
contract tag and commit it was built against. The 0.2.0 row above is not
release-complete until `openapi/SOURCE.md` and that row both point at an
immutable tag rather than a PR head; see `RELEASING.md` step 2.

## Runtime contract

The SDK uses browser-standard `fetch`, `Headers`, `URL`, `AbortController`,
`TextDecoder`, and readable response streams. It contains no native module,
Node builtin import, storage layer, UI framework dependency, or polyfill.
ES2020 is the compilation target. Importing the package does not fetch, read
credentials, touch DOM/storage, or start a timer; globals are checked when a
client is constructed. Node is required for development tooling, not shipped
as a browser dependency. Use the separate server SDK for server workloads.

No broad minimum-browser/version support promise is made by this foundation.
Actual engine/version results belong in release evidence. Chromium fixture
coverage does not certify Safari/WebKit, Firefox, mobile browsers, iframe
embedding, service-worker integrations, or a consuming application.

## Required customer-session boundary

The browser supplies only a server-minted, short-lived customer token. The
server must verify signature, issuer, audience, expiry, tenant, subject, and
customer scope, then check conversation ownership on every operation.
Management keys, signing keys, backend session cookies, and service tokens must
never be copied into this SDK's options or browser storage. CORS is not an
alternative to token validation and is not a protection against non-browser
clients.

The consuming application owns its authenticated/CSRF-protected token exchange,
trusted gateway configuration, identity-change cancellation, and customer UI.
The SDK does not persist a token or mint/verify a JWT. A token provider may use
your application's own same-origin session cookie to call its backend; that is
separate from SDK gateway requests, which always omit cookies.

## Current server CORS assessment

Read-only source inspection of the Daykeeper platform gateway at commit
`b783cf9b73f31106907eee74d0b85a0ce8c87345` found:

- OPTIONS reflects the supplied origin and permits Authorization/Content-Type
  preflights; it is not restricted to a tenant origin allowlist.
- Authenticated successful responses expose an exact origin only if it is in
  that tenant's `allowedOrigins` list.
- Authentication/upstream error paths omit those CORS response headers. A
  browser can see a network/CORS failure instead of the actual 401/403/5xx;
  GET token refresh therefore cannot be relied on for those responses yet.
- A disallowed Origin is not rejected before the authenticated operation runs.
  Missing response CORS headers are not an origin-based mutation denial.

No backend changes or deployed configuration checks are part of this SDK task.
This assessment is a pinned source observation, not a claim about every live
installation or later platform revisions.

The separate [gateway-origin PR #21](https://github.com/SkyPorch/daykeeper/pull/21),
commit `8842873c16e6f14208d24875088298e0a1fd70bc`, implements tenant-bound
pre-dispatch origin enforcement, restricted preflight and scoped error CORS.
It remains unmerged and undeployed. Its local browser and gateway tests do not
replace the deployed-candidate checks below. Review every existing consumer's
exact origin list before rollout; missing/empty lists deny browser requests,
and malformed/wildcard entries prevent startup.

Before cross-origin production use, the platform must:

1. Maintain exact approved scheme/host/port origins and check the authenticated
   tenant's origin policy before customer operations, including writes.
2. Restrict preflights to the intended origin/method/header policy without using
   an unsigned tenant claim as authorization; handle native/no-Origin clients
   intentionally rather than weakening browser policy.
3. Make expected 401/403/rate-limit/upstream errors readable for approved browser
   origins, with correct `Vary: Origin` behavior and no broad credentialed CORS.
4. Test denied origins, foreign-tenant tokens/conversations, expired tokens,
   logout, and accepted/failed writes against a deployed candidate gateway.
5. Keep the customer API free from redirects and cookies. Serve the final HTTPS
   gateway URL directly, and configure application CSP `connect-src` narrowly.

An application-owned same-origin reverse proxy can avoid a cross-origin browser
hop, but still requires all token/tenant checks and a reviewed proxy boundary.
It is not provisioned by this package.

## Deliberate exclusions

There is no visual messenger, install snippet, React wrapper, customer signup,
OAuth/billing/management-key UI, push setup, attachment upload, realtime socket,
offline queue, background retry, analytics, or lifecycle/erasure method here.
Generated types do not perform runtime response-schema validation. JSON is
bounded and must be an object, but the server remains responsible for accurate,
customer-safe contract payloads and tenant isolation.

## Evidence levels

- Unit tests: request contract, validation, cancellation, deadlines, one GET
  refresh, no automatic mutation replay, redaction, and bounded body reads.
- Packed consumer/bundle: install the actual tarball offline in a clean npm
  consumer, check ESM/CJS and declaration resolution, bundle for browsers, run
  the bundle without Node globals, and exercise real loopback HTTP transport.
- Optional engine check: use an installed Chromium binary and a fresh private
  profile; test cookies/referrers, CORS-visible and CORS-masked errors, blocked
  cross-origin redirects, and write behavior against synthetic local fixtures.
- Not established by any of the above: full browser matrix, real customer
  authentication, production gateway policy, delivered-message parity, visual
  messenger usability/accessibility, or commercial launch readiness.
