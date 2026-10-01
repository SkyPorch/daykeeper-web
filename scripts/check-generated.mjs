import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const contract = await readFile(join(root, "openapi/customer.yaml"));
const source = await readFile(join(root, "openapi/SOURCE.md"), "utf8");
const checksum = createHash("sha256").update(contract).digest("hex");
assert.equal(
  checksum,
  "6a72fea574acd85dfb678b3b63c927bb3ea6506814baa6f0e774842947c64b83",
);
assert(source.includes(checksum));
assert(source.includes("325c9496ab40fbb7da60f2fc75d57c9d5e1c2b39"));
const blob = createHash("sha1")
  .update(`blob ${contract.length}\0`)
  .update(contract)
  .digest("hex");
assert.equal(blob, "77d27d4603c5bfd16b97fb3fd517e429078113e2");
assert(source.includes(blob));
assert.match(contract.toString(), /identifier: Apache-2\.0/);
await mkdir(join(root, ".smoke"), { recursive: true });
const directory = await mkdtemp(join(root, ".smoke/generated-"));
const target = join(directory, "schema.ts");
await promisify(execFile)(
  join(root, "node_modules/.bin/openapi-typescript"),
  ["openapi/customer.yaml", "--output", target],
  { cwd: root, timeout: 60_000 },
);
assert(
  (await readFile(target)).equals(
    await readFile(join(root, "src/generated/schema.ts")),
  ),
  "Generated types differ; run pnpm generate and review the contract change",
);
console.log(
  `Customer contract checksum, Git blob, provenance and regeneration verified: ${checksum}`,
);
