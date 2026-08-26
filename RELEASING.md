# Releasing `@skyporch/daykeeper-web`

The package follows semantic versioning and records its exact customer OpenAPI
contract tag and commit.

Before the first release, choose and commit a license, scan the complete history
for secrets, make the repository public, confirm npm organization ownership and
2FA, and bootstrap the reviewed package interactively. npm cannot stage a
brand-new package.

Then configure npm trusted publishing for `SkyPorch/daykeeper-web`, workflow
`release.yml`, and environment `daykeeper-npm-production`. Protect the
environment with a non-author reviewer. Matching GitHub releases stage packages
through OIDC; a maintainer downloads and reviews the staged tarball and approves
it with npm 2FA. Stable releases use `latest`, prereleases use `next`, and no
long-lived npm token is stored in GitHub.
