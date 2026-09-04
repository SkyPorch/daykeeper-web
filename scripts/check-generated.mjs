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
  "b62dd386a87380f3fe94f968ff8fedf703ca6079199ea74057d32e31f91e1fec",
);
assert(source.includes(checksum));
assert(source.includes("e62cfd25228565b15fe169cd7b65a3279932b59f"));
const blob = createHash("sha1")
  .update(`blob ${contract.length}\0`)
  .update(contract)
  .digest("hex");
assert.equal(blob, "2f1b48fedaddfb7335389f75640e5e3b301575fb");
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
