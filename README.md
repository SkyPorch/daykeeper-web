# `@skyporch/daykeeper-web`

The official zero-runtime-dependency browser client for customer-facing
Daykeeper support experiences. It accepts only a short-lived, tenant-bound
customer token minted by the consuming application's backend. It never accepts
Daykeeper administrative or Chatwoot credentials.

## Install

```sh
npm install @skyporch/daykeeper-web
```

The package provides ESM, CommonJS, and TypeScript declarations for modern
browsers. React Native applications must use
`@skyporch/daykeeper-react-native`, whose runtime behavior and Metro exports are
tested separately.

## Use

```ts
import { createDaykeeperWebClient } from "@skyporch/daykeeper-web";

const daykeeper = createDaykeeperWebClient({
  baseUrl: "https://support.example.com/support-api",
  getAccessToken: async ({ forceRefresh }) => {
    const response = await fetch("/api/daykeeper-token", {
      method: "POST",
      credentials: "same-origin",
      headers: forceRefresh ? { "cache-control": "no-cache" } : undefined,
    });
    if (!response.ok) throw new Error("Could not start support");
    return (await response.json()).token;
  },
});

const { conversations } = await daykeeper.listConversations();
```

The token provider is called for every request so applications can rotate short
credentials. After HTTP 401, the SDK asks for one forced refresh and retries
exactly once. Do not store tokens in local storage, URLs, analytics, or logs.

## API

- `getIdentity()`
- `listConversations()` and `createConversation()`
- `listMessages()` and `sendMessage()`
- `getUnread()` and `markConversationSeen()`
- `claimAnonymousConversation()`

Private agent notes and activity records are filtered by the gateway. Use
`unreadForContact`, not Chatwoot's agent-side `unreadCount`, for customer
badges.

## Release status

No npm package has been published. Version `0.1.0` is generated from the
customer contract recorded in [`openapi/SOURCE.md`](openapi/SOURCE.md).
Publication remains blocked until SkyPorch approves the license, public
visibility, first-package bootstrap, and trusted publisher.
