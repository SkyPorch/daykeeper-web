# Contract source

`customer.yaml` is an exact copy of `openapi/customer.yaml` from
`SkyPorch/daykeeper-openapi`, commit
`924dafc661952c2f97cb41e609e6b531c1f44a7b` (license metadata, PR #7).

- SHA-256: `5dcbefc60a33dc844cff452c0828abd4d462eac8685ca4e1192544bbeca97e4d`
- Source Git blob: `6de29c4e6a80c9297a36579ddf19234b47ded8c8`
- Tag status: unreleased commit snapshot; no new upstream tag is claimed.

The released baseline is tag `v1.0.0`, commit
`35f5bd45fe0c6a6901766543bff90dae6838b965`. Provider-neutral wording came from
PR #5, commit `fec6f9b88661fbfd04b7d7c66acce257f15ea6bd`.
PR #7 aligns `info.license` with the contract's Apache-2.0 license. Operations,
schemas, scopes, and generated TypeScript types are unchanged. PR #8 entitlement
additions are not included.

The snapshot includes backend-only lifecycle and erasure operations. This
browser SDK exposes only the eight customer methods listed in its README;
there is no generic request method or service-operation wrapper. Its public
OpenAPI path/operation type aliases also exclude backend-only operations.

`src/generated/schema.ts` is generated with pinned `openapi-typescript@7.13.0`.
`pnpm check:generated` verifies the snapshot checksum and byte-for-byte
regeneration without changing the tracked file. Generation does not provide
runtime response-schema validation or independent tenant authorization.

The SDK's MIT license and the contract's Apache-2.0 license are both preserved;
see `NOTICE`, `LICENSE`, and `openapi/LICENSE`. Before a release, record a reviewed
immutable upstream tag and its full commit SHA, reverify the checksum, and
complete the browser/server integration gates in `RELEASING.md`.
