# Contract source

`customer.yaml` is an exact copy of `openapi/customer.yaml` from
`SkyPorch/daykeeper-openapi`, commit
`c9a0175d0053f1a2d57c9329f6d3a36ec6acdb71` (immutable `v1.1.0` release tag).

- SHA-256: `322158cd5fa5c54a054d701ff64a9c8b07cad477414d7df83ba5a3aa7ee06cc3`
- Source Git blob: `bf566c97a541ac5e4e1f04670fb3b65475b635a6`
- Tag status: `v1.1.0 (immutable release tag)`.

The released baseline is tag `v1.0.0`, commit
`35f5bd45fe0c6a6901766543bff90dae6838b965`. Provider-neutral wording came from
PR #5, commit `fec6f9b88661fbfd04b7d7c66acce257f15ea6bd`.
The customer snapshot retains Apache-2.0 metadata and adds optional safe usage
error guidance from PR #10. Existing response shapes remain valid. PR #13 opens
the `CustomerError` envelope (`additionalProperties: true`) so older clients
tolerate new members; this SDK ignores members it does not recognize. Management
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
