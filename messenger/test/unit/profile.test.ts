import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PROFILE,
  fetchProfile,
  parseProfile,
  photoUrl,
} from "../../src/profile.ts";
import { en } from "../../src/strings.ts";
import { returnParts } from "../../src/time.ts";

test("profile answers are validated, capped and never trusted blindly", () => {
  assert.deepEqual(
    parseProfile({
      data: {
        team: [
          {
            name: " Maya Chen ",
            avatarUrl: "https://support.example.test/m.png",
          },
          { name: "Leo", avatarUrl: "javascript:alert(1)" },
          { name: "", avatarUrl: "https://support.example.test/x.png" },
          { avatarUrl: "https://support.example.test/y.png" },
          "Sam",
          { name: "Sam", avatarUrl: null, email: "sam@example.test" },
          { name: "Four", avatarUrl: null },
        ],
        replyTime: {
          setting: "auto",
          expectation: "few_hours",
          open: true,
          nextOpenAt: "2026-10-14T13:00:00Z",
        },
      },
    }),
    {
      team: [
        { name: "Maya Chen", avatarUrl: "https://support.example.test/m.png" },
        { name: "Leo", avatarUrl: null },
        { name: "Sam", avatarUrl: null },
      ],
      replyTime: { expectation: "few_hours", open: true, nextOpenAt: null },
    },
  );
  assert.deepEqual(
    parseProfile({
      data: {
        team: [],
        replyTime: {
          expectation: "day",
          open: false,
          nextOpenAt: "2026-10-14T13:00:00.000Z",
        },
      },
    }).replyTime,
    { expectation: "day", open: false, nextOpenAt: Date.UTC(2026, 9, 14, 13) },
  );
  for (const junk of [
    null,
    "x",
    [],
    { data: null },
    { data: [] },
    { team: [{ name: "Not wrapped" }] },
  ])
    assert.deepEqual(parseProfile(junk), EMPTY_PROFILE, JSON.stringify(junk));
  assert.equal(
    parseProfile({ data: { replyTime: { expectation: "soon" } } }).replyTime,
    null,
  );
});

test("photos are https, or http on loopback for the mock", () => {
  assert.equal(
    photoUrl("https://s.example.test/a.png"),
    "https://s.example.test/a.png",
  );
  assert.equal(
    photoUrl("http://127.0.0.1:4411/avatars/maya.svg"),
    "http://127.0.0.1:4411/avatars/maya.svg",
  );
  for (const bad of [
    "http://support.example.test/a.png",
    "https://user:pass@s.example.test/a.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "/relative.png",
    `https://s.example.test/${"a".repeat(2050)}`,
    42,
    null,
  ])
    assert.equal(photoUrl(bad), null, String(bad));
});

test("an older gateway or a failure reads as no team and no reply line", async () => {
  const original = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  try {
    for (const answer of [
      () => new Response('{"error":"not_found"}', { status: 404 }),
      () => new Response("not json", { status: 200 }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]) {
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return answer();
      }) as typeof fetch;
      assert.deepEqual(
        await fetchProfile("https://gateway.example.test", "tok"),
        EMPTY_PROFILE,
      );
    }
    globalThis.fetch = (async () =>
      Response.json({
        data: { team: [{ name: "Maya", avatarUrl: null }], replyTime: null },
      })) as typeof fetch;
    assert.deepEqual(
      await fetchProfile("https://gateway.example.test", "tok"),
      {
        team: [{ name: "Maya", avatarUrl: null }],
        replyTime: null,
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0]!.url, "https://gateway.example.test/v1/messenger");
  assert.equal(
    (seen[0]!.init.headers as Record<string, string>).authorization,
    "Bearer tok",
  );
  assert.equal(seen[0]!.init.credentials, "omit");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal(seen[0]!.init.referrerPolicy, "no-referrer");
});

test("reply-time lines and the away line read naturally", () => {
  assert.equal(en.replyTime.few_minutes, "We typically reply in a few minutes");
  assert.equal(en.replyTime.asap, "We'll reply as soon as we can");
  const now = new Date(2026, 9, 14, 20, 0).getTime();
  const tomorrow = returnParts(
    new Date(2026, 9, 15, 9, 0).getTime(),
    now,
    "en-US",
  );
  assert.deepEqual(tomorrow, { day: "tomorrow", time: "9:00 AM" });
  assert.equal(
    en.awayBack(en.backAt(tomorrow!.day, tomorrow!.time)),
    "We're away right now. Back tomorrow at 9:00 AM.",
  );
  assert.deepEqual(
    returnParts(new Date(2026, 9, 14, 22, 30).getTime(), now, "en-US"),
    { day: "today", time: "10:30 PM" },
  );
  assert.deepEqual(
    returnParts(new Date(2026, 9, 19, 9, 0).getTime(), now, "en-US"),
    { day: "Monday", time: "9:00 AM" },
  );
  // Other locales come from Intl, not from English words.
  assert.equal(
    returnParts(new Date(2026, 9, 15, 9, 0).getTime(), now, "es")?.day,
    "mañana",
  );
  assert.equal(returnParts(now - 1, now, "en-US"), null);
  assert.equal(returnParts(null, now, "en-US"), null);
  assert.equal(
    returnParts(new Date(2026, 9, 30).getTime(), now, "en-US"),
    null,
  );
  assert.equal(en.teamLabel(["Maya"]), "Maya");
  assert.equal(en.teamLabel(["Maya", "Leo", "Sam"]), "Maya, Leo and Sam");
});
