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
  "ae75711072950c786d69401301292659ece7f37461cf0621ae4f8a58836b82bd",
);
assert(source.includes(checksum));
assert(source.includes("4a2b82c9b23503073dc26fdeb5163e8869d007b8"));
const blob = createHash("sha1")
  .update(`blob ${contract.length}\0`)
  .update(contract)
  .digest("hex");
assert.equal(blob, "9cdf5423e73ad8008fc62adeb8c66e3c018c357d");
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
