# Releasing

`@skyporch/daykeeper-web` is still `private: true` and therefore unpublished.
That block is deliberate and is **not** removed by this document or by the
release workflow: dropping `private: true` is a separate, separately approved
change. `publishConfig` now declares `access: public` and `provenance: true` so
that the first publication, whenever it is approved, is a provenance-producing
one — but `npm publish` continues to fail closed while `private: true` stands,
and `prepublishOnly` (`scripts/verify-release.mjs`) fails closed independently.
A local tarball is for review and testing, not evidence of a public release.

## Release sequence

Releases follow this exact order. Do not reorder or skip a step.

1. **Tag the contract first.** Create the immutable release tag
   `vMAJOR.MINOR.PATCH` in `SkyPorch/daykeeper-openapi` for the customer
   contract this version builds against. Per that repository's `VERSIONING.md`,
   release tags are immutable and every SDK release records the exact contract
   tag and commit it used.
2. **Repoint the vendored contract.** Update `openapi/SOURCE.md` to that
   immutable **tag** plus its full commit SHA, and reverify the recorded
   SHA-256 of `openapi/customer.yaml`. Never point at a branch head or an
   unmerged pull request head. Update the contract row in `COMPATIBILITY.md` to
   match.
3. **Finalize the changelog.** Give the version its section in `CHANGELOG.md`
   with no `unreleased` marker left anywhere in the file.
4. **One reviewed version-bump commit.** Bump `package.json`, land steps 2–3 in
   the same reviewed commit, and merge it to `main`.
5. **Create the GitHub release from a tag on `main`.** The release's target
   must be `main`, and the tag must already be an ancestor of `main`.
   `.github/workflows/release.yml` verifies both before any repository code is
   checked out or executed, and refuses to continue otherwise.
6. **Let the workflow publish.** `release.yml` runs `pnpm check`,
   `scripts/verify-release.mjs`, and then publishes with `--provenance` through
   OIDC trusted publishing. No long-lived npm token exists in this repository
   and none may be added; `id-token: write` is granted only on the publish job.
7. **Verify the attestation after publication.** Check both
   `https://registry.npmjs.org/-/npm/v1/attestations/@skyporch/daykeeper-web@<version>`
   and `npm view @skyporch/daykeeper-web@<version> dist.attestations`. A release
   with no attestation is not complete; investigate before announcing it.

A dry run of everything up to and including `npm publish --dry-run
--provenance` is available without a release: run the workflow manually
(`workflow_dispatch`) with `dry_run: true` (the default). The dry-run path never
publishes and never stages, and it skips the tag-ancestry gate because a manual
dispatch has no release tag.

## 0.1.0 has no provenance attestation

`@skyporch/daykeeper@0.1.0` and `@skyporch/daykeeper-react-native@0.1.0` were
published **by hand**, with no provenance attestation, even though their
`package.json` declares `publishConfig.provenance: true`. That declaration
describes intent; it does not retroactively attest anything. No GitHub release
exists in any Daykeeper repository and no `release.yml` has ever run.

This cannot be fixed retroactively for 0.1.0. npm attestations are produced at
publish time by the publishing environment; a version already on the registry
cannot acquire one, and republishing the same version is not possible. Treat
every 0.1.0 artifact as unattested and say so if asked.

The fix is forward-only: the first release driven by `release.yml` — from a
GitHub release, on a tag verified to be an ancestor of `main`, with
`id-token: write` on the publish job and `--provenance` on the publish command —
is the first Daykeeper artifact that carries a real attestation. Step 7 above is
how you confirm it actually happened.

## Approval gates before public bootstrap

Before this package is published at all, a maintainer must approve all of the
following. These gates are unchanged and remain in force.

- Review the full diff and history for private consumer/provider references,
  secrets, personal/customer data, and credentials; review dependency contents.
- Confirm the MIT runtime license and preserved native attribution, plus the
  exact Apache-2.0 contract provenance and notices. Do not relabel the contract
  or silently replace its untagged PR #7 snapshot with an unrelated API.
- Record an approved immutable OpenAPI tag, full commit SHA, and checksum
  (release sequence steps 1–2). PR #8 entitlement/service additions are outside
  this release surface.
- Pass `pnpm check` (which now includes `pnpm pack:verify`), `pnpm
smoke:browser`, and `pnpm check:cold`; preserve Node, package-manager,
  browser-engine versions, tarball checksum, and test evidence.
- Complete the server Origin enforcement/error-CORS gates in COMPATIBILITY.md,
  then verify the packed SDK against an authorized deployed candidate without
  using administrative keys in a browser.
- Certify supported browser engines and identity/logout/auth-refresh scenarios.
  Confirm that a consuming application's UI safely renders customer content.
- Approve repository visibility, npm scope/package ownership and 2FA, version,
  changelog, release notes, support policy, and tarball contents.
- In a separate reviewed change, remove the `private: true` bootstrap block.
  The provenance-producing trusted-publisher workflow itself already exists at
  `.github/workflows/release.yml`.

Do not interpret successful CI or a git tag as publication approval. Do not
publish automatically from a pull request or direct branch push. No release,
deployment, merge, entitlement expansion, or production configuration change is
performed by this foundation.
