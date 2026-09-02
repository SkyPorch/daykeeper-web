# Release gates

`@skyporch/daykeeper-web@0.1.0` is an unpublished foundation. `private: true`
blocks npm publication, and `prepublishOnly` independently fails closed. There
is no active publishing path or long-lived registry token in this repository.
A protected workflow is present for a later approved release, but the current
bootstrap guard deliberately prevents it from staging this candidate.
A local tarball is for review and testing, not evidence of a public release.

Before public bootstrap, a maintainer must approve all of the following:

- Review the full diff and history for private consumer/provider references,
  secrets, personal/customer data, and credentials; review dependency contents.
- Confirm the MIT runtime license and preserved native attribution, plus the
  exact Apache-2.0 contract provenance and notices. Do not relabel the contract
  or silently replace its untagged PR #7 snapshot with an unrelated API.
- Record an approved immutable OpenAPI tag, full commit SHA, and checksum.
  PR #8 entitlement/service additions are outside this release surface.
- Pass `pnpm check`, `pnpm smoke:browser`, and `pnpm check:cold`; preserve Node,
  package-manager, browser-engine versions, tarball checksum, and test evidence.
- Complete the server Origin enforcement/error-CORS gates in COMPATIBILITY.md,
  then verify the packed SDK against an authorized deployed candidate without
  using administrative keys in a browser.
- Certify supported browser engines and identity/logout/auth-refresh scenarios.
  Confirm that a consuming application's UI safely renders customer content.
- Approve repository visibility, npm scope/package ownership and 2FA, version,
  changelog, release notes, support policy, and tarball contents.
- In a separate reviewed change, remove the private/bootstrap blocks. Bootstrap
  the new npm package interactively under maintainer approval because npm cannot
  stage a brand-new package.
- Configure npm trusted publishing for organization `SkyPorch`, repository
  `daykeeper-web`, workflow `release.yml`, protected environment
  `daykeeper-npm-production`, and **stage publish only**. Set protected variable
  `DAYKEEPER_RELEASE_APPROVED` to `1` and require a non-author reviewer.

After bootstrap, a matching GitHub Release checks out the exact tag, runs the
package, browser and cold-store gates, and submits the artifact with
`npm stage publish` through OIDC. A maintainer must download and review it, then
approve it with npm 2FA. The workflow cannot approve publication.

CI scans the complete candidate history with a checksum-pinned Gitleaks binary.
A clean current checkout does not waive a credential in an older commit.

Do not interpret successful CI or a git tag as publication approval. Do not
publish automatically from a pull request or direct branch push. No release,
deployment, merge, entitlement expansion, or production configuration change is
performed by this foundation.
