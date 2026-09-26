/**
 * Where an anonymous visitor's identity lives between page loads.
 *
 * `localStorage["dk:messenger:" + publishableKey]` holds
 * `{visitorId, secret, hasConversation}`. The secret is the only proof that
 * resumes this visitor's conversations, so nothing else is written and nothing
 * is written before the visitor-session exchange mints one.
 *
 * Storage can be missing or hostile: Safari private mode and sandboxed frames
 * throw on access, quota can be full, and another script can write garbage
 * under our key. Every failure falls back to an in-memory record so the
 * messenger keeps working for the life of the page.
 */
export interface StoredVisitor {
  visitorId: string;
  secret: string;
  hasConversation: boolean;
}

export interface VisitorStore {
  read(): StoredVisitor | null;
  write(value: StoredVisitor): void;
  clear(): void;
  /** True when records survive a reload; false once we fell back to memory. */
  readonly persistent: boolean;
}

export const VISITOR_ID_PATTERN = /^v_[a-z2-7]{26}$/;
export const VISITOR_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function storageKey(publishableKey: string): string {
  return `dk:messenger:${publishableKey}`;
}

export function parseStoredVisitor(raw: unknown): StoredVisitor | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.visitorId !== "string" ||
    !VISITOR_ID_PATTERN.test(record.visitorId) ||
    typeof record.secret !== "string" ||
    !VISITOR_SECRET_PATTERN.test(record.secret)
  ) {
    return null;
  }
  return {
    visitorId: record.visitorId,
    secret: record.secret,
    hasConversation: record.hasConversation === true,
  };
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createVisitorStore(
  publishableKey: string,
  storage: () => StorageLike | null | undefined = () => globalThis.localStorage,
): VisitorStore {
  const key = storageKey(publishableKey);
  let memory: StoredVisitor | null = null;
  let backing: StorageLike | null = null;
  try {
    backing = storage() ?? null;
    // Probe once: some browsers expose localStorage but throw on write.
    if (backing) {
      const probe = `${key}:probe`;
      backing.setItem(probe, "1");
      backing.removeItem(probe);
    }
  } catch {
    backing = null;
  }

  const fallBack = () => {
    backing = null;
  };

  return {
    get persistent() {
      return backing !== null;
    },
    read() {
      if (!backing) return memory;
      try {
        const parsed = parseStoredVisitor(backing.getItem(key));
        return parsed ?? memory;
      } catch {
        fallBack();
        return memory;
      }
    },
    write(value) {
      memory = { ...value };
      if (!backing) return;
      try {
        backing.setItem(key, JSON.stringify(memory));
      } catch {
        fallBack();
      }
    },
    clear() {
      memory = null;
      if (!backing) return;
      try {
        backing.removeItem(key);
      } catch {
        fallBack();
      }
    },
  };
}
