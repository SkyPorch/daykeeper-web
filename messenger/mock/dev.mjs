#!/usr/bin/env node
// Local playground: `pnpm --filter @skyporch/daykeeper-messenger dev`.
// Serves the demo site and the mock gateway on loopback and turns on the
// mock's automatic AI-agent reply.
import { startMock } from "./server.mjs";

const mock = await startMock({
  sitePort: Number(process.env.SITE_PORT ?? 4410),
  gatewayPort: Number(process.env.GATEWAY_PORT ?? 4411),
  log: true,
});
await mock.configure({ autoReply: true });
console.log(`
Daykeeper Messenger mock (loopback only)
  demo page       ${mock.siteUrl}/
  hostile CSS     ${mock.siteUrl}/hostile
  dark / left     ${mock.siteUrl}/?theme=dark&position=left
  gateway         ${mock.gatewayUrl}

Simulate replies to the newest conversation:
  curl -s -XPOST ${mock.gatewayUrl}/__mock/reply -H 'content-type: application/json' -d '{"author":"agent","content":"Hi! I can help with that."}'
  curl -s -XPOST ${mock.gatewayUrl}/__mock/reply -H 'content-type: application/json' -d '{"author":"human","content":"Maya here, taking over."}'
`);
