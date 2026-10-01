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
  "1072bb8df15e4f96bb9463f8bb77d9b5a7b0b97d762ee25599bee6f81dd55b51",
);
assert(source.includes(checksum));
assert(source.includes("f7771f5ce1d48140ddbf38a113aeec60651b8d79"));
const blob = createHash("sha1")
  .update(`blob ${contract.length}\0`)
  .update(contract)
  .digest("hex");
assert.equal(blob, "7285478b62e6ec33b2c35e7503508a73930433b8");
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
