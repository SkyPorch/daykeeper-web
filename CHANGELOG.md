# Changelog

## 0.1.0 — unreleased

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
