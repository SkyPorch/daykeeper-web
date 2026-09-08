# `@skyporch/daykeeper-web`

A headless browser client for customer-facing Daykeeper support experiences.
It provides typed customer operations, not a visual messenger, installation
snippet, React wrapper, or administrative API.

Version `0.2.0` is the first approved public release candidate. Publication is
performed only by the protected release workflow after the gates in
[RELEASING.md](RELEASING.md) are satisfied.

## Evaluate locally

```sh
pnpm install --frozen-lockfile
pnpm check
npm pack
# In a separate application, install the reviewed local .tgz file.
npm install /path/to/skyporch-daykeeper-web-0.2.0.tgz
```

The package has no runtime dependencies. It ships ESM, CommonJS, and TypeScript
declarations. Use the server SDK for administrative work; never ship a service
or management credential in browser code.

## Use

Your backend must authenticate the signed-in customer and mint a short-lived
Daykeeper customer-session token bound to that customer and tenant. The SDK
does not implement that backend exchange, signup, billing, or API-key creation.

```ts
import { createDaykeeperWebClient } from "@skyporch/daykeeper-web";
import { exchangeCustomerSession } from "./your-application-session";

const daykeeper = createDaykeeperWebClient({
  // Trusted application configuration, never a URL supplied by a visitor.
  baseUrl: "https://support.example.com/support-api",
  getAccessToken: ({ forceRefresh, signal }) =>
    exchangeCustomerSession({ forceRefresh, signal }),
  timeoutMs: 30_000,
});

const controller = new AbortController();
const { conversations } = await daykeeper.listConversations({
  signal: controller.signal,
});
// Abort pending work when the customer signs out or the view is destroyed.
controller.abort();
```

`exchangeCustomerSession` above is an application-owned helper, not an export
from this package. It should call your authenticated backend, honor `signal`,
and bypass any in-memory token cache when `forceRefresh` is true. Protect the
backend exchange against CSRF and bind identity server-side; do not accept an
arbitrary browser-supplied tenant or subject as authorization.

The provider runs for every request. The SDK stores no token cache, cookies,
localStorage, sessionStorage, or IndexedDB data and performs no background
polling. A fixed short-lived token can be supplied through `getAccessToken:
() => token` for a controlled session, but the consuming app still owns renewal
and sign-out cancellation. Token validity, tenant ownership, scope, and expiry
must be enforced by the server; the SDK cannot prove them client-side.

## Customer API

| Method                                              | Behavior                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `getIdentity(options?)`                             | Read verified customer identity.                                    |
| `listConversations(options?)`                       | Read customer-owned conversation summaries.                         |
| `createConversation(options?)`                      | Explicitly create a conversation.                                   |
| `listMessages(conversationId, { after?, signal? })` | Read visible messages; optional positive-integer cursor.            |
| `sendMessage(conversationId, content, options?)`    | Explicitly send trimmed plain text, up to 16,000 UTF-16 code units. |
| `getUnread(options?)`                               | Read customer-side unread state.                                    |
| `markConversationSeen(conversationId, options?)`    | Explicitly persist a seen marker.                                   |
| `claimAnonymousConversation(widgetToken, options?)` | Explicitly claim an existing anonymous thread after sign-in.        |

`options` accepts an optional `AbortSignal`. IDs and cursors must be positive
safe integers. Anonymous claim does not bootstrap an anonymous widget or create
a widget token. The exact OpenAPI snapshot includes backend lifecycle/erasure
routes, but those routes are intentionally not exposed by this client.

API-only gateways expose conversation APIs but not the embedded widget
experience: `getIdentity()` and `claimAnonymousConversation()` require a
widget-enabled tenant and return HTTP 409 with the safe `widget_unavailable`
code on an API-only gateway. API-only routes also reject browser Origin headers;
this SDK does not bypass that restriction. Browser integrations require a
website inbox with an admitted origin. Use a native client for API-only mobile
integrations.

Returned content is untrusted customer/agent data. Render plain text safely;
do not insert messages into `innerHTML`. A future visual messenger must supply
its own reviewed rendering, accessibility, attachment, and navigation policies.

## Deadlines, authentication, and writes

One request budget covers token acquisition, an optional GET authentication
refresh, fetch, and response reads. The default is 30 seconds; `timeoutMs`
accepts integers from 1,000 through 60,000 milliseconds. Bodies are limited to
1 MiB of decoded response bytes. Standard browser streaming bodies are stopped
at that limit; a buffered custom transport can only be checked after its
`text()` promise resolves and is still covered by the deadline.

Only a **GET** that returns an observable HTTP 401 gets one forced token refresh
and one retry, using the original deadline and abort signal. No other status or
network failure is automatically retried. CORS can hide an HTTP error from
JavaScript, in which case the SDK cannot inspect the status or refresh it.

**POST methods are never automatically replayed, including after HTTP 401.**
An abort, timeout, network failure, malformed response, or server failure after
a write was dispatched may leave its outcome unknown. Cancelling a request does
not undo a conversation, message, claim, or seen marker accepted by the server.
Read/reconcile state before deciding whether to submit another explicit write.
This contract provides no write idempotency-key option; the SDK invents none.

## Errors

`DaykeeperWebApiError` exposes `status`, `code`, `retryable`, `outcomeUnknown`,
and an optional `nextAction`. The gateway's error vocabulary is open, so a
`code` is passed through whenever it has the documented shape
(`^[a-z][a-z0-9_]{2,63}$`, checked by the exported `isDaykeeperApiErrorCode`);
anything else, including free-form server prose, becomes
`daykeeper_request_failed`. `nextAction` is limited to the documented values.
The response `message` is never read, so no raw response body reaches an error.

`DaykeeperWebTransportError` exposes the same decision fields except HTTP
status. Codes include `INVALID_CONFIGURATION`, `TOKEN_PROVIDER_ERROR`,
`REQUEST_ABORTED`, `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `INVALID_RESPONSE`,
`RESPONSE_TOO_LARGE`, and `REDIRECT_REJECTED`. Provider/network exceptions,
abort reasons, headers, response bodies, and URLs are not attached to errors.

`retryable` is always false for writes. For reads it identifies a potentially
transient failure, not an automatic retry loop or a guarantee of success.
`outcomeUnknown` flags dispatched writes whose result cannot be safely inferred.

For reads, a boolean server `retryable` hint overrides legacy HTTP-status
inference. In particular, a quota 429 or setup 503 with `retryable: false` must
not enter a retry loop. Invalid or absent hints keep the legacy read behavior;
no hint authorizes replay of a write.

Known managed errors include `daykeeper_usage_limit_exceeded`,
`daykeeper_usage_not_enabled`, `daykeeper_support_not_ready`,
`daykeeper_resource_conflict`, and `daykeeper_support_unavailable`. Render
reviewed, localized guidance based on these codes. Keep an unsent message
visible and let customers read existing conversations. Do not show a successful
send, offer automatic quota upgrades, or display raw server messages/URLs.
An uncertain write needs reconciliation, not an automatic resend.

`widget_unavailable` is a non-retryable mode error. Do not refresh credentials,
retry, or switch tenants automatically when an API-only gateway returns it.

## Browser integration

Every gateway request uses `credentials: "omit"`, `mode: "cors"`,
`redirect: "error"`, `cache: "no-store"`, and `referrerPolicy: "no-referrer"`.
HTTPS is required except for literal loopback development origins: `localhost`,
IPv4 `127.0.0.0/8`, and `[::1]`. LAN addresses and emulator host aliases are not
loopback. URLs with credentials, query strings, or fragments are rejected.

An advanced custom `fetch` must preserve this policy. The SDK rejects returned
redirect metadata, but cannot undo a credential leak caused by a custom
transport, extension, or service worker that already ignored redirect policy.

Cross-origin use requires a configured gateway origin policy, successful
Authorization/JSON preflights, and readable error responses. The inspected
platform baseline has origin/error-CORS gaps addressed in a separate, unmerged
gateway PR; this SDK alone does not close the deployment gates.
See [COMPATIBILITY.md](COMPATIBILITY.md). There is no live
production browser certification or full-app parity claim in this foundation.

## Development and provenance

Run `pnpm check` for deterministic local checks and a real packed npm consumer
plus browser-target bundle smoke. `pnpm smoke:browser` additionally exercises
that packed bundle in an installed Chromium engine with a fresh temporary
profile and local fixtures only. `pnpm check:cold` repeats the checks from a
new dependency store and copied source with the frozen lockfile.

These are distinct evidence levels; a Node/VM bundle check is not a browser
engine test, and local browser fixtures are not a deployed gateway test.
See [CONTRIBUTING.md](CONTRIBUTING.md), [COMPATIBILITY.md](COMPATIBILITY.md), and
[openapi/SOURCE.md](openapi/SOURCE.md) for exact scope and provenance.

Runtime code is MIT, with the native SDK attribution preserved. The vendored
contract and generated types retain Apache-2.0 notices; see [NOTICE](NOTICE).
