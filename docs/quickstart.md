# Quickstart

A minimal browser integration. The client takes two things: the gateway base
URL, and a `getAccessToken` function that returns a short-lived,
customer-scoped token minted by **your own** backend. The SDK never mints,
verifies, or stores a token, and it never sends cookies to the gateway.

## Configuration

Read the gateway URL from your build's environment. Only the gateway URL is a
build-time value; the token is fetched at runtime from your own session.

```
DAYKEEPER_API_URL=https://gateway.example/support-api
```

Never put a management key, signing key, or service token in browser
configuration. The only credential that belongs in the browser is the
short-lived customer token your backend returns.

## Example

```js
import { createDaykeeperWebClient } from "@skyporch/daykeeper-web";

// Your bundler substitutes this at build time.
const baseUrl = process.env.DAYKEEPER_API_URL;

const daykeeper = createDaykeeperWebClient({
  baseUrl,
  // Called on the first request and again with forceRefresh after a 401.
  async getAccessToken({ forceRefresh, signal }) {
    const response = await fetch("/api/support-token", {
      method: "POST",
      credentials: "same-origin", // your app's session, not the gateway's
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forceRefresh }),
      signal,
    });
    if (!response.ok) throw new Error("Could not mint a support token");
    const { token } = await response.json();
    return token;
  },
});

const { conversations } = await daykeeper.listConversations();
const conversation =
  conversations[0] ?? (await daykeeper.createConversation()).conversation;

await daykeeper.sendMessage(conversation.id, "Hello from the web SDK");

const { messages } = await daykeeper.listMessages(conversation.id);
console.log(messages.length);
```

## Cancellation

Every method accepts a `signal`, so a closing panel can abort in flight:

```js
const controller = new AbortController();
const unread = await daykeeper.getUnread({ signal: controller.signal });
```

Errors arrive as `DaykeeperWebApiError` (a gateway error with a stable `code`)
or `DaykeeperWebTransportError` (network, timeout, or configuration). Raw
server prose is never exposed; switch on `code` and always keep a default
branch. See `README.md` for the full method list and `COMPATIBILITY.md` for the
session and CORS requirements your server must satisfy first.
