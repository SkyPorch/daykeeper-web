/** Chatwoot timestamps arrive as epoch seconds; accept ms and ISO too. */
export function toMillis(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    if (/^\d+(\.\d+)?$/.test(value)) return toMillis(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Short relative time for message metadata: "Just now", "5 min. ago",
 * "3 hr. ago", "Yesterday", then a calendar date. Formatting is delegated
 * to Intl so a new locale needs no code.
 */
export function relativeTime(
  at: number | null,
  now: number,
  locale: string | undefined,
  justNow = "Just now",
): string {
  if (at === null) return "";
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return justNow;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, {
      numeric: "auto",
      style: "short",
    });
    if (delta < HOUR) return rtf.format(-Math.floor(delta / MINUTE), "minute");
    if (delta < DAY) return rtf.format(-Math.floor(delta / HOUR), "hour");
    if (delta < 7 * DAY) return rtf.format(-Math.floor(delta / DAY), "day");
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      ...(new Date(at).getFullYear() !== new Date(now).getFullYear()
        ? { year: "numeric" }
        : {}),
    }).format(at);
  } catch {
    return new Date(at).toLocaleDateString();
  }
}

/** Absolute timestamp for a `<time>` title/tooltip. */
export function absoluteTime(
  at: number | null,
  locale: string | undefined,
): string {
  if (at === null) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(at);
  } catch {
    return new Date(at).toString();
  }
}

/**
 * When the team is back, as the two halves `Strings.backAt` joins: the day
 * ("today", "tomorrow" from Intl's relative format, then a weekday name) and
 * the local time. Null when `at` is unusable or more than a week out.
 */
export function returnParts(
  at: number | null,
  now: number,
  locale: string | undefined,
): { day: string; time: string } | null {
  if (at === null || !Number.isFinite(at) || at <= now) return null;
  const startOf = (value: number) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOf(at) - startOf(now)) / DAY);
  if (days > 7) return null;
  try {
    const time = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
    const day =
      days <= 1
        ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
            days,
            "day",
          )
        : new Intl.DateTimeFormat(locale, { weekday: "long" }).format(at);
    return { day, time };
  } catch {
    return null;
  }
}
