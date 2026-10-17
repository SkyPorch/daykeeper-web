# Changelog

## Unreleased

### Added

- Hosted messenger: the company logo. The visitor-session exchange's optional
  `inbox.logoUrl` (Daykeeper server contract 1.13.0) replaces the inbox's
  initial in the topbar, thread intro, unassigned conversation rows and
  AI-agent replies, and stays in the home topbar beside the team. A logo that
  the page's CSP blocks, or that fails to load, falls back to the initial.
  Sites with a strict CSP add `img-src https://cdn.mydaykeeper.com`. The
  headless `@skyporch/daykeeper-web` package is unchanged.

## 0.3.0 — 2026-10-15

### Added

- Default device context. Every request sends a `Daykeeper-Client` header
  (base64url JSON) describing the browser: platform `web`, OS name and
  version, `iPhone`/`iPad`/`iPod` model when known, browser name and version,
  language, time zone, and `sdk: "web"` with the package version. It comes
  from low-entropy User-Agent Client Hints with a small user-agent fallback,
  is computed once and lazily, and is sent only from a page (`window` and
  `document` present, not jsdom or happy-dom). Browser names and versions are
  sent only as plain text. It never
  includes the user-agent string, URLs, page titles, referrers, screen or
  hardware details, or identifiers. Opt out with `sendDeviceContext: false`.
  **Deploy the gateway that allows `daykeeper-client` in CORS preflights
  first**: an older gateway refuses the preflight and
  every browser request fails. See the release gate in
  [RELEASING.md](RELEASING.md#release-gate-gateway-allows-daykeeper-client).
- The hosted messenger sends the same header as `sdk: "web-messenger"` with
  its own version on gateway requests (not on the visitor-session exchange),
  with a `sendDeviceContext` boot option to opt out (`false`, `"false"`, `0`
  or `"0"`).

### Changed

- The vendored customer contract is pinned to immutable OpenAPI tag
  `v1.11.0` (customer contract 0.2.0), which documents the optional
  `Daykeeper-Client` header. Generated types gain that optional header
  parameter; request and response shapes are otherwise unchanged.

## 0.2.0

### Breaking

- `isDaykeeperApiErrorCode` and the error surface no longer restrict
  `DaykeeperWebApiError.code` to a fixed allowlist. Any gateway code matching
  `^[a-z][a-z0-9_]{2,63}$` is now passed through unchanged, and only free-form
  server prose collapses to `daykeeper_request_failed`. Code that treated the
  old closed union as exhaustive — a `switch` without a `default`, or an
  exhaustiveness assertion over the union — must add a fallback branch. This is
  this package's own break and the reason the release is 0.2.0 rather than
  0.1.1.
- The browser transport policy (no redirects, no ambient credentials, no
  cookies or referrer) is now pinned onto the `Request` object rather than
  passed through `RequestInit`. An injected `fetch` that previously relaxed
  those settings can no longer do so, and a transport that rejects a
  pre-built `Request` must be updated.

The required `Idempotency-Key` header introduced by the Daykeeper **management**
contract 0.2.0 does **not** apply to this package. `daykeeper-web` vendors the
**customer** contract, which is still 0.1.0 and defines no `Idempotency-Key`
header and no `200`-alongside-`201` replay response. No request this SDK sends
changes because of the management contract bump. See `COMPATIBILITY.md`.

### Changes

- Add a provenance-producing release workflow, a documented release sequence in
  `RELEASING.md`, a version/contract table in `COMPATIBILITY.md`, and
  `docs/quickstart.md`. The package stays `private: true`; removing that block
  is a separate approved change.
- Add `scripts/verify-pack.mjs` (`pnpm pack:verify`, now part of `pnpm check`):
  it packs twice and compares per-file content digests, rejects test/fixture
  paths in the tarball, and requires source maps to stay inside `dist`.
- Rewrite published source-map `sources` to dist-local names. They previously
  pointed at `../src/*.ts`, which is not published, so a consumer's debugger
  could not resolve them; the original text is still embedded in
  `sourcesContent`.
- Tolerate an open error envelope: unknown members in an error body are ignored
  and the response still parses to the typed error.
- Pass through any gateway error code with the documented shape
  (`^[a-z][a-z0-9_]{2,63}$`, exported as `isDaykeeperApiErrorCode`) instead of a
  fixed allowlist that dropped codes consuming apps switch on. Free-form server
  prose still collapses to `daykeeper_request_failed`, and `message` is never
  read.
- Expose a `nextAction` hint alongside `retryable`, limited to the documented
  values; unrecognized hints and raw messages are still withheld.
- Apply the browser transport policy (no redirects, no ambient credentials) to
  the Request object, so an injected `fetch` cannot bypass it.
- Preserve the five safe managed usage error codes and explicit boolean retry
  advice for reads. Writes remain non-retryable, with uncertain outcomes intact.
- Honor explicit non-retry advice before a 401 token refresh; bound that body
  read by the existing deadline and cancellation, without replaying on timeout.
- Update the exact customer contract snapshot; no raw message or recovery URL
  from an error response is exposed.
- Add a headless browser customer client with ESM, CommonJS, and TypeScript exports.
- Vendor the exact OpenAPI PR #11 customer snapshot with recorded provenance and
  preserved Apache-2.0 notices; retain MIT for the native-derived runtime.
- Bound token acquisition, GET auth refresh, fetch, and body reads with one
  deadline and caller cancellation. Omit cookies/referrers and reject redirects.
- Redact raw errors and prohibit automatic mutation replay.
- Add local contract/security/lifecycle, packed-consumer, browser-fixture, and
  cold-cache validation; document unresolved production integration gates.

This entry is not a publication announcement or production-parity claim.
