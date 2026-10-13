/**
 * The people behind the inbox and how soon they reply: `GET /v1/messenger`
 * on the gateway. Everything here is optional decoration. The floating `v1`
 * script can meet a gateway that predates the route, so a 404, a network
 * failure or a malformed answer all read as "no team, no reply-time line",
 * never as an error the visitor sees.
 */

export interface TeamMember {
  name: string;
  /** An http(s) photo URL on the support workspace origin, or null. */
  avatarUrl: string | null;
}

export type ReplyExpectation = "few_minutes" | "few_hours" | "day" | "asap";

export interface ReplyTime {
  expectation: ReplyExpectation;
  open: boolean;
  /** Epoch milliseconds the team is next in, when it is away. */
  nextOpenAt: number | null;
}

export interface MessengerProfile {
  team: TeamMember[];
  replyTime: ReplyTime | null;
}

export const EMPTY_PROFILE: MessengerProfile = Object.freeze({
  team: [],
  replyTime: null,
}) as MessengerProfile;

export type ProfileFetcher = (
  gatewayUrl: string,
  token: string,
) => Promise<MessengerProfile>;

const EXPECTATIONS = new Set<ReplyExpectation>([
  "few_minutes",
  "few_hours",
  "day",
  "asap",
]);
const MAX_RESPONSE_CHARS = 32_768;
const TIMEOUT_MS = 10_000;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** https, or http on loopback (the mock); never credentials or a fragment. */
export function photoUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && LOOPBACK.test(url.hostname))
      return url.href;
  } catch {
    /* not a URL */
  }
  return null;
}

export function teamMemberOf(value: unknown): TeamMember | null {
  const entry = record(value);
  const name =
    typeof entry?.name === "string" ? entry.name.trim().slice(0, 80) : "";
  if (!name) return null;
  return { name, avatarUrl: photoUrl(entry?.avatarUrl) };
}

export function parseProfile(payload: unknown): MessengerProfile {
  const data = record(record(payload)?.data);
  if (!data) return EMPTY_PROFILE;
  const team = (Array.isArray(data.team) ? data.team : [])
    .map(teamMemberOf)
    .filter((member): member is TeamMember => member !== null)
    .slice(0, 3);
  const reply = record(data.replyTime);
  const expectation = reply?.expectation;
  const nextOpenAt =
    typeof reply?.nextOpenAt === "string" ? Date.parse(reply.nextOpenAt) : NaN;
  return {
    team,
    replyTime:
      reply && EXPECTATIONS.has(expectation as ReplyExpectation)
        ? {
            expectation: expectation as ReplyExpectation,
            open: reply.open !== false,
            nextOpenAt:
              reply.open === false && Number.isFinite(nextOpenAt)
                ? nextOpenAt
                : null,
          }
        : null,
  };
}

/** The real fetcher: same transport policy as the session exchange. */
export const fetchProfile: ProfileFetcher = async (gatewayUrl, token) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(`${gatewayUrl}/v1/messenger`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: controller.signal,
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return EMPTY_PROFILE;
    const text = await response.text();
    if (!text || text.length > MAX_RESPONSE_CHARS) return EMPTY_PROFILE;
    return parseProfile(JSON.parse(text));
  } catch {
    return EMPTY_PROFILE;
  } finally {
    clearTimeout(timer);
  }
};
