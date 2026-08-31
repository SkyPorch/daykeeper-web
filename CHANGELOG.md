# Changelog

## 0.1.0 — unreleased

- Preserve the five safe managed usage error codes and explicit boolean retry
  advice for reads. Writes remain non-retryable, with uncertain outcomes intact.
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
