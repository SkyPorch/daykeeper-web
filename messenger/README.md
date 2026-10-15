# Daykeeper Messenger (`@skyporch/daykeeper-messenger`)

The hosted, Intercom-style web messenger for Daykeeper API inboxes with a web
client. It is a **private** workspace package: it is never published to npm.
It ships as one self-contained IIFE, `messenger.js`, served from the Daykeeper
CDN. It bundles the headless `@skyporch/daykeeper-web` client from this
repository's `src/`, and it does not change that package.

## Install on a website

```html
<script>
  window.Daykeeper =
    window.Daykeeper ||
    function () {
      (Daykeeper.q = Daykeeper.q || []).push(arguments);
    };
  Daykeeper("boot", { publishableKey: "dk_pk_…" });
</script>
<script
  async
  src="https://cdn.mydaykeeper.com/messenger/v1/messenger.js"
></script>
```

The site's origin must be one of the web client's allowed websites. Under a
strict CSP, allow the snippet by hash (or nonce), `script-src
https://cdn.mydaykeeper.com`, and `connect-src https://gateway.mydaykeeper.com`.
Teammates' photos load from the support workspace origin: add `img-src
https://support.mydaykeeper.com` (plus the storage host its avatar URLs
redirect to, if the workspace keeps uploads off-host). Without it the photos
are blocked and the messenger shows the teammates' initials instead. No inline
styles, `eval` or remote fonts are used, photos are requested with
`referrerpolicy="no-referrer"`, and the messenger works with
`require-trusted-types-for 'script'`.

### API

| Call                                                                       | Effect                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Daykeeper('boot', options)`                                               | Mount the launcher. `publishableKey` is required; optional `gatewayUrl`, `locale`, `theme` (`auto`/`light`/`dark`), `position` (`right`/`left`), `hideLauncher`, `zIndex`, `sendDeviceContext`. |
| `Daykeeper('shutdown', { forget? })`                                       | Stop polling and remove the messenger; `forget: true` also deletes the stored visitor.                                                                                                          |
| `Daykeeper('show' \| 'hide' \| 'toggle')`                                  | Open or close the panel.                                                                                                                                                                        |
| `Daykeeper('showNewMessage', text?)`                                       | Open a new conversation with the composer prefilled (never sent automatically).                                                                                                                 |
| `Daykeeper('on', 'ready' \| 'open' \| 'close' \| 'unreadCountChange', cb)` | Subscribe; returns an unsubscribe function once the script has loaded.                                                                                                                          |

`window.Daykeeper` is the only global. The UI lives in a closed shadow root
on a `<daykeeper-messenger>` element and is unaffected by page CSS.

## Behaviour

- **Visitor identity.** Nothing touches the network until the panel opens, or
  until a returning visitor who already has a conversation loads the page.
  `POST /v1/visitor-sessions` mints a visitor (id + secret, returned once) or
  resumes one. `localStorage["dk:messenger:" + publishableKey]` holds
  `{visitorId, secret, hasConversation}`, and memory is used when storage is
  unavailable. `visitor_proof_invalid` drops the stored visitor and mints a
  new one, once.
- **Tokens.** Five-minute tokens stay in memory and are refreshed 60 s before
  expiry. Expiry is measured from the token's own `exp - iat` on the local
  clock, so a skewed visitor clock does no harm. The gateway reflects CORS only
  after it verifies a token, so a rejected token looks like a network failure.
  After one, the next call exchanges a fresh token first. Writes are never
  replayed automatically. An uncertain send is reconciled against the thread,
  and if it never appears the visitor is offered **Retry**.
- **Polling.** With the panel closed and a conversation on record, `/v1/unread`
  is polled every 30 s while the page is visible, every 120 s while it is
  hidden, and every 5 min after an error. With a thread open, `…/messages?after=<id>` is
  polled every 4 s, then every 15 s after two idle minutes, and every 120 s
  while hidden. Errors back off exponentially up to 5 min. The home view
  refreshes the conversation list every 30 s. `POST …/seen` is sent once new
  agent or human replies are on screen.
- **Team and reply time.** Once the panel is open, `GET /v1/messenger` (at
  most every 5 min) returns up to three teammates (`name`, `avatarUrl`) and
  the reply-time expectation. Home shows their overlapping avatars above the
  greeting and one line under it: "We typically reply in a few minutes / in a
  few hours / in a day", "We'll reply as soon as we can", or, outside business
  hours, "We're away right now. Back tomorrow at 9:00 AM." in the visitor's
  locale. The thread's topbar and intro use the same stack instead of the
  inbox monogram, conversation rows show the assigned person, and a person's
  replies show their photo. A gateway without the route (404), a failure or a
  malformed answer leaves all of this out: the monogram stays and no line is
  shown.
- **Device context.** Gateway requests (conversations, messages, unread,
  seen, `/v1/messenger`) carry a `Daykeeper-Client` header so agents see the
  visitor's browser on the contact: base64url JSON with platform `web`, OS
  name and version, `iPhone`/`iPad`/`iPod` when known, browser name and version,
  language, time zone, and `sdk: "web-messenger"` with the messenger version.
  It never includes the user-agent string, page URLs or titles, referrers,
  screen details or identifiers. The visitor-session exchange does not send
  it. `sendDeviceContext: false` in `boot` (or `"false"`, `0`, `"0"`) sends none. The gateway must allow
  `daykeeper-client` in its CORS preflight before a messenger that sends it is
  released; an older gateway refuses the preflight and the messenger cannot
  connect.
- **Errors.** `web_client_unavailable` and `web_client_disabled` show "Chat is
  unavailable" and stop all traffic. `origin_not_allowed` stops traffic too.
  `temporarily_unavailable` and network failures show a connection state with
  **Try again** and back off automatically. Usage limits and
  `content_too_long` keep the message and explain why.

## Develop

```sh
pnpm install
pnpm --filter @skyporch/daykeeper-messenger dev       # demo site + mock gateway on 127.0.0.1:4410/4411
pnpm --filter @skyporch/daykeeper-messenger check     # typecheck, unit tests, build, 40 KB gzip budget
pnpm --filter @skyporch/daykeeper-messenger exec playwright install chromium   # once
pnpm --filter @skyporch/daykeeper-messenger e2e       # Playwright + axe against the mock
SCREENSHOT_DIR=/tmp/shots pnpm --filter @skyporch/daykeeper-messenger screenshots
```

`mock/server.mjs` implements the visitor-session exchange and the visitor
customer routes with synthetic data. It binds to 127.0.0.1 only and exposes a
local `/__mock/*` control API (`reply`, `fail`, `config`, `seed`, `revoke`,
`rotate-signing-key`, `state`). `config` takes `team`, `replyTime` and
`messengerRoute: false` (answer `/v1/messenger` with 404, like an older
gateway); synthetic avatar SVGs are served from the mock gateway, and
`?photos=0` drops it from the demo page's `img-src`. `/hostile` serves the demo with
`* { all: unset !important }` page CSS under a strict CSP with Trusted Types.

## Release

```sh
pnpm --filter @skyporch/daykeeper-messenger release
```

This builds, enforces the size budget, and writes:

- `release/messenger/<version>/messenger.js`: immutable; serve with
  `Cache-Control: public, max-age=31536000, immutable`
- `release/messenger/v1/messenger.js`: alias; serve with `Cache-Control:
public, max-age=300`
- `release/manifest.json`: byte size, SHA-256 and the SRI `integrity` value
  (`sha384-…`) for the immutable URL
- `release/messenger-<version>.js.map`: kept with the release record and not
  served

Serve both files with `Access-Control-Allow-Origin: *`,
`X-Content-Type-Options: nosniff` and `Content-Type: text/javascript;
charset=utf-8`. Sites that pin a version can add
`integrity="<manifest.integrity>" crossorigin="anonymous"` to the versioned
URL. The `v1` alias changes between releases, so it cannot carry SRI.
