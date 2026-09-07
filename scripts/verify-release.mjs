import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const FULL_CHECKSUM = /^[0-9a-f]{64}$/i;

export function validateRelease({
  manifest,
  source,
  changelog,
  contractBytes,
  env,
}) {
  if (!manifest || typeof manifest !== "object")
    throw new Error("package.json must contain an object");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version))
    throw new Error("package version must be semantic versioning");
  if (manifest.private === true)
    throw new Error("package.json.private must be false for publication");
  if (env.DAYKEEPER_RELEASE_APPROVED !== "1")
    throw new Error("DAYKEEPER_RELEASE_APPROVED=1 is required");
  if (
    env.GITHUB_EVENT_NAME === "release" &&
    env.GITHUB_REF_NAME !== `v${manifest.version}`
  )
    throw new Error("Git tag must match package version");

  const commit = source.match(/commit\s+`([0-9a-f]{40})`/i)?.[1];
  if (!commit || !FULL_SHA.test(commit))
    throw new Error(
      "openapi/SOURCE.md must record a full immutable contract commit SHA",
    );
  const tagStatus = source.match(/Tag status:\s*([^\n]+)/i)?.[1] ?? "";
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s+\(immutable release tag\)\.?$/i.test(
      tagStatus.trim(),
    )
  )
    throw new Error(
      "openapi/SOURCE.md must record an immutable release tag, not an unreleased snapshot",
    );
  const recorded = source.match(/SHA-256:\s*`([0-9a-f]{64})`/i)?.[1];
  if (!recorded || !FULL_CHECKSUM.test(recorded))
    throw new Error("openapi/SOURCE.md must record a full contract checksum");
  const actual = createHash("sha256").update(contractBytes).digest("hex");
  if (actual !== recorded.toLowerCase())
    throw new Error(
      "vendored customer contract checksum does not match SOURCE.md",
    );

  const escaped = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+${escaped}(?:\\s|$)`, "m");
  if (!heading.test(changelog) || /unreleased/i.test(changelog))
    throw new Error(
      "CHANGELOG.md must contain a finalized heading for the package version",
    );
  return {
    version: manifest.version,
    contractCommit: commit.toLowerCase(),
    contractTag: tagStatus.trim(),
    contractSha256: recorded.toLowerCase(),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const source = await readFile("openapi/SOURCE.md", "utf8");
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const contractBytes = await readFile("openapi/customer.yaml");
  const result = validateRelease({
    manifest,
    source,
    changelog,
    contractBytes,
    env: process.env,
  });
  console.log(
    `Release metadata verified for ${result.version} (${result.contractTag}, ${result.contractCommit})`,
  );
}
