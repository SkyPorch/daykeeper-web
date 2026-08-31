# Contract source

`customer.yaml` is an exact copy of `openapi/customer.yaml` from
`SkyPorch/daykeeper-openapi`, commit
`e62cfd25228565b15fe169cd7b65a3279932b59f` (usage contracts, PR #11).

- SHA-256: `b62dd386a87380f3fe94f968ff8fedf703ca6079199ea74057d32e31f91e1fec`
- Source Git blob: `2f1b48fedaddfb7335389f75640e5e3b301575fb`
- Tag status: unreleased commit snapshot; no new upstream tag is claimed.

The released baseline is tag `v1.0.0`, commit
`35f5bd45fe0c6a6901766543bff90dae6838b965`. Provider-neutral wording came from
PR #5, commit `fec6f9b88661fbfd04b7d7c66acce257f15ea6bd`.
The customer snapshot retains Apache-2.0 metadata and adds optional safe usage
error guidance from PR #10. Existing response shapes remain valid. Management
usage and entitlement operations are not exposed by this customer SDK.

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
