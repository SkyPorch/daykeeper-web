# Contributing

Use the pinned pnpm version in package.json and `pnpm install --frozen-lockfile`.
Run `pnpm check`; use `pnpm smoke:browser` for actual Chromium fixture coverage
and `pnpm check:cold` for a new-store reproducibility run. All checks use
synthetic fixtures; no Daykeeper/customer/admin credential is needed.

Contract changes start in `SkyPorch/daykeeper-openapi`. Preserve the exact
snapshot and both licenses, update its provenance deliberately, then run
`pnpm generate`. Never hand-edit generated declarations or expose backend-only
routes merely because they exist in the vendored contract.

Keep the public surface browser-standard and headless. Preserve one deadline
across credentials, GET auth refresh, fetch, and body reads; omit cookies and
referrers; reject redirects; redact raw errors; and never automatically replay
writes. Add regression tests for every security or lifecycle change.

Do not add persistent token stores, management credentials, telemetry, background
polling, unbounded queues, runtime Node imports, or release automation without
an independently reviewed requirement. Test evidence and temporary browser
profiles remain in ignored task directories, never in the published tarball.

SDK changes do not authorize backend changes or live customer tests. Report
integration gaps explicitly. This repository remains private/unpublished until
maintainer approval; local commits do not authorize pushes or releases.
