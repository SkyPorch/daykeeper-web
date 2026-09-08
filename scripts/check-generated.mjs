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
  "322158cd5fa5c54a054d701ff64a9c8b07cad477414d7df83ba5a3aa7ee06cc3",
);
assert(source.includes(checksum));
assert(source.includes("c9a0175d0053f1a2d57c9329f6d3a36ec6acdb71"));
const blob = createHash("sha1")
  .update(`blob ${contract.length}\0`)
  .update(contract)
  .digest("hex");
assert.equal(blob, "bf566c97a541ac5e4e1f04670fb3b65475b635a6");
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
