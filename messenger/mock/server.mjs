// Local mock of the Daykeeper visitor-session exchange and the visitor-facing
// customer gateway routes (SPEC §3/§4), for development, screenshots and
// Playwright. Synthetic data only; binds to 127.0.0.1 and refuses any request
// whose Host is not loopback. Never point it at, or proxy it to, a real
// gateway.
//
// Two listeners:
//   site    — demo pages + /messenger.js served like the CDN (CORS *, nosniff)
//   gateway — POST /v1/visitor-sessions and the customer routes, plus a
//             /__mock/* control API for tests (not CORS-enabled)
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { pages } from "./pages.mjs";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

export const PUBLISHABLE_KEY = "dk_pk_Demo0000000000000000000000000001";
const TENANT = "dk_00000000-0000-4000-8000-000000000001";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const defaultConfig = () => ({
  state: "enabled",
  allowedOrigins: [],
  inbox: {
    name: "Fern & Field",
    greeting: "Hi there. Ask us anything about your order, sizing or returns.",
    accentColor: null,
  },
  agentName: "Fern",
  humanName: "Maya Chen",
  tokenLifetimeSeconds: 300,
  autoReply: false,
  autoReplyDelayMs: 1200,
  exposeSessionErrors: false,
});

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (text) => createHash("sha256").update(text).digest();
const now = () => Math.floor(Date.now() / 1000);

function mintVisitorId() {
  const bytes = randomBytes(26);
  return `v_${Array.from(bytes, (byte) => BASE32[byte & 31]).join("")}`;
}

function isLoopbackHost(host) {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

export async function startMock({
  sitePort = 0,
  gatewayPort = 0,
  log = false,
} = {}) {
  let config = defaultConfig();
  let signingKey = randomBytes(32);
  const visitors = new Map(); // id -> { secretHash, name }
  const conversations = new Map(); // id -> conversation
  let conversationSeq = 100;
  let messageSeq = 5000;
  const failures = []; // { route, status, code, times }
  const requests = []; // { method, path, at }
  const timers = new Set();

  const say = (...args) => log && console.log("[mock]", ...args);

  // ---- tokens -----------------------------------------------------------
  const signToken = (claims) => {
    const body = b64url(JSON.stringify(claims));
    const mac = b64url(createHmac("sha256", signingKey).update(body).digest());
    return `mock.${body}.${mac}`;
  };
  const verifyToken = (token) => {
    const [prefix, body, mac] = String(token).split(".");
    if (prefix !== "mock" || !body || !mac) return { error: "invalid_token" };
    const expected = createHmac("sha256", signingKey).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return { error: "invalid_signature" };
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (claims.exp <= now()) return { error: "expired_token" };
    if (claims.dk_visitor !== true || !/^v_[a-z2-7]{26}$/.test(claims.sub))
      return { error: "invalid_token" };
    return { claims };
  };

  // ---- data -------------------------------------------------------------
  const outgoing = (message) =>
    message.message_type === 1 && message.author !== "system";
  const unreadFor = (conversation) =>
    conversation.messages.filter(
      (message) =>
        outgoing(message) && message.id > conversation.lastSeenMessageId,
    ).length;
  const summary = (conversation) => {
    const visible = conversation.messages.filter(
      (message) => message.message_type !== 2,
    );
    const last = visible.at(-1);
    return {
      id: conversation.id,
      status: "open",
      createdAt: conversation.createdAt,
      updatedAt: last?.created_at ?? conversation.createdAt,
      unreadCount: 0,
      unreadForContact: unreadFor(conversation),
      lastSeenAt: conversation.lastSeenAt,
      preview: last?.content ?? null,
    };
  };
  const wireMessage = (message) => ({
    id: message.id,
    conversationId: message.conversation_id,
    content: message.content,
    contentType: "text",
    contentAttributes: {},
    messageType: message.message_type,
    createdAt: message.created_at,
    sender: message.sender,
    attachments: message.attachments ?? [],
    author: message.author,
  });
  const addMessage = (
    conversation,
    { author, content, senderName, attachments },
  ) => {
    const message = {
      id: ++messageSeq,
      conversation_id: conversation.id,
      content,
      attachments: Array.isArray(attachments) ? attachments : [],
      message_type: author === "customer" ? 0 : 1,
      created_at: now(),
      sender:
        author === "customer"
          ? { name: senderName ?? "Visitor", avatarUrl: null }
          : author === "system"
            ? null
            : {
                name: author === "agent" ? config.agentName : config.humanName,
                avatarUrl: null,
              },
      author,
    };
    conversation.messages.push(message);
    return message;
  };
  const conversationsOf = (sub) =>
    [...conversations.values()].filter(
      (conversation) => conversation.sub === sub,
    );

  // ---- helpers ------------------------------------------------------------
  const send = (response, status, body, headers = {}) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    });
    response.end(body === null ? "" : JSON.stringify(body));
  };
  const readBody = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024)
        throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid_request"), { status: 400 });
    }
  };
  const takeFailure = (route) => {
    const failure = failures.find(
      (entry) => entry.route === route && entry.times > 0,
    );
    if (!failure) return null;
    failure.times -= 1;
    return failure;
  };
  const originAllowed = (origin) =>
    !!origin && config.allowedOrigins.includes(origin);
  const cors = (origin) => ({
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "retry-after",
    vary: "Origin",
  });

  // ---- gateway ------------------------------------------------------------
  const gateway = createServer(async (request, response) => {
    try {
      if (!isLoopbackHost(request.headers.host)) {
        response.writeHead(421).end();
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const origin = request.headers.origin;
      if (!url.pathname.startsWith("/__mock/")) {
        requests.push({
          method: request.method,
          path: url.pathname + url.search,
          at: Date.now(),
        });
        say(request.method, url.pathname + url.search);
      }

      // Control API (test process only; deliberately no CORS).
      if (url.pathname.startsWith("/__mock/")) {
        if (origin)
          return send(response, 403, { error: "control_api_is_local_only" });
        return control(request, response, url);
      }

      if (request.method === "OPTIONS") {
        if (!originAllowed(origin))
          return send(response, 403, null, { vary: "Origin" });
        return send(response, 204, null, {
          ...cors(origin),
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, accept",
          "access-control-max-age": "600",
        });
      }

      if (url.pathname === "/v1/visitor-sessions")
        return visitorSession(request, response, origin);

      // Customer routes: token first, then tenant-bound origin, then allowlist.
      const auth = request.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const verified = token
        ? verifyToken(token)
        : { error: "missing_bearer_token" };
      if (verified.error) return send(response, 401, { error: verified.error });
      if (origin && !originAllowed(origin))
        return send(response, 403, { error: "origin_not_allowed" });
      const headers = origin ? cors(origin) : {};
      if (config.state !== "enabled")
        return send(response, 403, { error: "web_client_disabled" }, headers);
      const { sub } = verified.claims;
      const route = routeOf(request.method, url.pathname);
      if (!route)
        return send(response, 403, { error: "visitor_not_allowed" }, headers);
      const failure = takeFailure(route.name);
      if (failure) {
        if (failure.status === 0) {
          request.socket.destroy();
          return;
        }
        return send(response, failure.status, { error: failure.code }, headers);
      }
      return route.handle({
        request,
        response,
        url,
        sub,
        headers,
        params: route.params,
      });
    } catch (error) {
      send(response, error.status ?? 500, {
        error: error.status === 400 ? "invalid_request" : "internal_error",
      });
    }
  });

  const owned = (sub, id) => {
    const conversation = conversations.get(Number(id));
    return conversation && conversation.sub === sub ? conversation : null;
  };

  function routeOf(method, path) {
    if (path === "/v1/conversations" && method === "GET")
      return { name: "list", handle: listConversations };
    if (path === "/v1/conversations" && method === "POST")
      return { name: "create", handle: createConversation };
    if (path === "/v1/unread" && method === "GET")
      return { name: "unread", handle: unread };
    let match = path.match(/^\/v1\/conversations\/(\d+)\/messages$/);
    if (match && method === "GET")
      return {
        name: "messages",
        handle: listMessages,
        params: { id: match[1] },
      };
    if (match && method === "POST")
      return { name: "send", handle: sendMessage, params: { id: match[1] } };
    match = path.match(/^\/v1\/conversations\/(\d+)\/seen$/);
    if (match && method === "POST")
      return { name: "seen", handle: seen, params: { id: match[1] } };
    return null;
  }

  function listConversations({ response, sub, headers }) {
    const list = conversationsOf(sub).map(summary);
    send(
      response,
      200,
      {
        conversations: list,
        widgetConversationId:
          list.reduce((max, entry) => Math.max(max, entry.id), 0) || null,
      },
      headers,
    );
  }

  function createConversation({ response, sub, headers }) {
    const conversation = {
      id: ++conversationSeq,
      sub,
      createdAt: now(),
      lastSeenAt: null,
      lastSeenMessageId: 0,
      messages: [],
    };
    conversations.set(conversation.id, conversation);
    send(response, 201, { conversation: summary(conversation) }, headers);
  }

  function unread({ response, sub, headers }) {
    const list = conversationsOf(sub)
      .filter((entry) => unreadFor(entry) > 0)
      .map(summary);
    send(
      response,
      200,
      {
        unreadCount: list.reduce(
          (sum, entry) => sum + entry.unreadForContact,
          0,
        ),
        conversation: list[0] ?? null,
        conversations: list,
      },
      headers,
    );
  }

  function listMessages({ response, url, sub, headers, params }) {
    const conversation = owned(sub, params.id);
    if (!conversation)
      return send(response, 404, { error: "unknown_conversation" }, headers);
    const cursor = (name) => {
      const values = url.searchParams.getAll(name);
      if (!values.length) return undefined;
      if (
        values.length !== 1 ||
        !/^\d+$/.test(values[0]) ||
        !Number.isSafeInteger(Number(values[0])) ||
        Number(values[0]) <= 0
      ) {
        return null;
      }
      return Number(values[0]);
    };
    const after = cursor("after");
    const before = cursor("before");
    if (
      after === null ||
      before === null ||
      (after !== undefined && before !== undefined)
    ) {
      return send(response, 400, { error: "invalid_message_cursor" }, headers);
    }
    let page = conversation.messages;
    if (before !== undefined)
      page = page.filter((message) => message.id < before).slice(-20);
    else if (after !== undefined)
      page = page.filter((message) => message.id > after).slice(0, 20);
    else page = page.slice(-20);
    send(
      response,
      200,
      {
        messages: page.map(wireMessage),
      },
      headers,
    );
  }

  async function sendMessage({ request, response, sub, headers, params }) {
    const conversation = owned(sub, params.id);
    if (!conversation)
      return send(response, 404, { error: "unknown_conversation" }, headers);
    const body = await readBody(request);
    if (typeof body.content !== "string" || !body.content.trim())
      return send(
        response,
        400,
        { error: "Message content is required" },
        headers,
      );
    if (body.content.length > 4000)
      return send(response, 400, { error: "content_too_long" }, headers);
    const message = addMessage(conversation, {
      author: "customer",
      content: body.content.trim(),
      senderName: visitors.get(sub)?.name,
    });
    send(response, 201, { message: wireMessage(message) }, headers);
    if (config.autoReply) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        addMessage(conversation, {
          author: "agent",
          content:
            "Thanks for reaching out! I'm looking into this now. A teammate can jump in if you need anything I can't handle.",
        });
      }, config.autoReplyDelayMs);
      timers.add(timer);
    }
  }

  function seen({ response, sub, headers, params }) {
    const conversation = owned(sub, params.id);
    if (!conversation)
      return send(response, 404, { error: "unknown_conversation" }, headers);
    conversation.lastSeenAt = now();
    conversation.lastSeenMessageId = conversation.messages.at(-1)?.id ?? 0;
    send(
      response,
      200,
      {
        conversationId: conversation.id,
        seen: true,
        seenAt: conversation.lastSeenAt,
        seenMessageId: conversation.lastSeenMessageId,
      },
      headers,
    );
  }

  async function visitorSession(request, response, origin) {
    if (request.method !== "POST")
      return send(response, 405, { error: "invalid_request" });
    if (!origin) return send(response, 400, { error: "invalid_request" });
    const failure = takeFailure("sessions");
    const body = await readBody(request);
    const keyOk = body.publishableKey === PUBLISHABLE_KEY;
    // ACAO only for this key's origins (SPEC §3), so an unknown or disabled
    // key is normally an unreadable response. `exposeSessionErrors` models a
    // service that also reflects registered origins on error responses.
    const headers =
      (keyOk || config.exposeSessionErrors) && originAllowed(origin)
        ? cors(origin)
        : { vary: "Origin" };
    if (failure) {
      if (failure.status === 0) {
        request.socket.destroy();
        return;
      }
      return send(response, failure.status, { error: failure.code }, headers);
    }
    if (typeof body.publishableKey !== "string")
      return send(response, 400, { error: "invalid_request" }, headers);
    if (!keyOk || config.state !== "enabled")
      return send(response, 404, { error: "web_client_unavailable" }, headers);
    if (!originAllowed(origin))
      return send(response, 403, { error: "origin_not_allowed" }, headers);
    let visitorId;
    let secret;
    if (body.visitor !== undefined) {
      const { id, secret: given } = body.visitor ?? {};
      if (typeof id !== "string" || typeof given !== "string")
        return send(response, 400, { error: "invalid_request" }, headers);
      const record = visitors.get(id);
      const hash = sha256(given);
      if (
        !record ||
        record.revoked ||
        !timingSafeEqual(record.secretHash, hash)
      )
        return send(response, 401, { error: "visitor_proof_invalid" }, headers);
      visitorId = id;
    } else {
      visitorId = mintVisitorId();
      secret = b64url(randomBytes(32));
      const name = `Visitor ${randomBytes(2).toString("hex").toUpperCase()}`;
      visitors.set(visitorId, { secretHash: sha256(secret), name });
    }
    const iat = now();
    const exp = iat + config.tokenLifetimeSeconds;
    const token = signToken({
      tenant: TENANT,
      sub: visitorId,
      dk_visitor: true,
      name: visitors.get(visitorId).name,
      locale: typeof body.locale === "string" ? body.locale : "en",
      platform: "web",
      web_origin: origin,
      iat,
      exp,
    });
    send(
      response,
      secret ? 201 : 200,
      {
        data: {
          token,
          tokenType: "Bearer",
          expiresAt: new Date(exp * 1000).toISOString(),
          gatewayUrl: gatewayUrl,
          visitor: secret ? { id: visitorId, secret } : { id: visitorId },
          inbox: config.inbox,
        },
      },
      headers,
    );
  }

  async function control(request, response, url) {
    const body = request.method === "POST" ? await readBody(request) : {};
    switch (url.pathname) {
      case "/__mock/state":
        return send(response, 200, {
          config,
          visitors: [...visitors.keys()],
          conversations: [...conversations.values()].map((conversation) => ({
            ...summary(conversation),
            sub: conversation.sub,
            messages: conversation.messages.map(wireMessage),
          })),
          requests,
        });
      case "/__mock/config":
        config = {
          ...config,
          ...body,
          inbox: { ...config.inbox, ...(body.inbox ?? {}) },
        };
        return send(response, 200, { config });
      case "/__mock/reset":
        config = { ...defaultConfig(), allowedOrigins: [siteUrl] };
        visitors.clear();
        conversations.clear();
        failures.length = 0;
        requests.length = 0;
        return send(response, 200, { ok: true });
      case "/__mock/fail":
        failures.push({
          route: body.route,
          status: body.status ?? 503,
          code: body.code ?? "temporarily_unavailable",
          times: body.times ?? 1,
        });
        return send(response, 200, { ok: true });
      case "/__mock/rotate-signing-key":
        // Every issued token now fails verification (401 invalid_signature).
        signingKey = randomBytes(32);
        return send(response, 200, { ok: true });
      case "/__mock/revoke":
        for (const record of visitors.values()) record.revoked = true;
        return send(response, 200, { ok: true });
      case "/__mock/reply": {
        const list = [...conversations.values()];
        const conversation = body.conversationId
          ? conversations.get(Number(body.conversationId))
          : list.at(-1);
        if (!conversation)
          return send(response, 404, { error: "no_conversation" });
        const message = addMessage(conversation, {
          author: body.author ?? "agent",
          content: body.content ?? "Happy to help!",
        });
        if (body.author === "human" && body.senderName)
          message.sender.name = body.senderName;
        return send(response, 200, { message: wireMessage(message) });
      }
      case "/__mock/seed": {
        // Seed a visitor with history; returns the stored-visitor record the
        // page can put in localStorage to resume it.
        const visitorId = mintVisitorId();
        const secret = b64url(randomBytes(32));
        visitors.set(visitorId, {
          secretHash: sha256(secret),
          name: "Visitor 4F2A",
        });
        for (const thread of body.conversations ?? []) {
          const conversation = {
            id: ++conversationSeq,
            sub: visitorId,
            createdAt: now() - (thread.ageSeconds ?? 0),
            lastSeenAt: null,
            lastSeenMessageId: 0,
            messages: [],
          };
          conversations.set(conversation.id, conversation);
          for (const entry of thread.messages ?? []) {
            const message = addMessage(conversation, entry);
            message.created_at = now() - (entry.ageSeconds ?? 0);
            if (entry.senderName && message.sender)
              message.sender.name = entry.senderName;
          }
          if (thread.seen) conversation.lastSeenMessageId = messageSeq;
        }
        return send(response, 200, {
          visitorId,
          secret,
          hasConversation: true,
        });
      }
      default:
        return send(response, 404, { error: "not_found" });
    }
  }

  // ---- site (demo pages + CDN-like script) --------------------------------
  const site = createServer(async (request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      response.writeHead(421).end();
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (
        url.pathname === "/messenger.js" ||
        url.pathname === "/messenger.js.map"
      ) {
        const file = await readFile(`${DIST}${url.pathname.slice(1)}`);
        response.writeHead(200, {
          "content-type": url.pathname.endsWith(".map")
            ? "application/json"
            : "text/javascript; charset=utf-8",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        return response.end(file);
      }
      if (url.pathname === "/hostile.css") {
        response.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        return response.end(await readFile(`${HERE}hostile.css`));
      }
      if (url.pathname === "/site.css") {
        response.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        return response.end(await readFile(`${HERE}site.css`));
      }
      const page = pages({
        path: url.pathname,
        query: url.searchParams,
        gatewayUrl,
        publishableKey: PUBLISHABLE_KEY,
      });
      if (!page) {
        response.writeHead(404, { "content-type": "text/plain" });
        return response.end("not found");
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        ...(page.csp ? { "content-security-policy": page.csp } : {}),
      });
      return response.end(page.html);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error?.message ?? error));
    }
  });

  gateway.listen(gatewayPort, "127.0.0.1");
  site.listen(sitePort, "127.0.0.1");
  await Promise.all([once(gateway, "listening"), once(site, "listening")]);
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  config.allowedOrigins = [siteUrl];

  const post = async (path, body = {}) => {
    const result = await fetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return result.json();
  };

  return {
    siteUrl,
    gatewayUrl,
    publishableKey: PUBLISHABLE_KEY,
    reply: (body) => post("/__mock/reply", body),
    configure: (body) => post("/__mock/config", body),
    fail: (body) => post("/__mock/fail", body),
    revoke: () => post("/__mock/revoke"),
    rotateSigningKey: () => post("/__mock/rotate-signing-key"),
    reset: () => post("/__mock/reset"),
    seed: (body) => post("/__mock/seed", body),
    state: async () => (await fetch(`${gatewayUrl}/__mock/state`)).json(),
    async close() {
      for (const timer of timers) clearTimeout(timer);
      gateway.closeAllConnections?.();
      site.closeAllConnections?.();
      await Promise.all([
        new Promise((resolve) => gateway.close(resolve)),
        new Promise((resolve) => site.close(resolve)),
      ]);
    },
  };
}
