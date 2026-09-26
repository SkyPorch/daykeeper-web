import assert from "node:assert/strict";
import test from "node:test";
import {
  createVisitorStore,
  parseStoredVisitor,
  storageKey,
} from "../../src/storage.ts";

const KEY = "dk_pk_Test0000000000000000000000000001";
const visitor = {
  visitorId: "v_abcdefghijklmnopqrstuvwxyz",
  secret: "A".repeat(43),
  hasConversation: false,
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("persists the visitor under dk:messenger:<publishableKey>", () => {
  const storage = memoryStorage();
  const store = createVisitorStore(KEY, () => storage);
  assert.equal(store.persistent, true);
  assert.equal(store.read(), null);
  store.write(visitor);
  assert.deepEqual(JSON.parse(storage.map.get(storageKey(KEY))!), visitor);
  const reopened = createVisitorStore(KEY, () => storage);
  assert.deepEqual(reopened.read(), visitor);
  reopened.clear();
  assert.equal(storage.map.has(storageKey(KEY)), false);
  assert.equal(reopened.read(), null);
});

test("ignores malformed or tampered records", () => {
  assert.equal(parseStoredVisitor(null), null);
  assert.equal(parseStoredVisitor("{"), null);
  assert.equal(parseStoredVisitor("[]"), null);
  assert.equal(
    parseStoredVisitor(JSON.stringify({ ...visitor, visitorId: "v_UPPER" })),
    null,
  );
  assert.equal(
    parseStoredVisitor(JSON.stringify({ ...visitor, secret: "short" })),
    null,
  );
  assert.equal(parseStoredVisitor("x".repeat(600)), null);
  assert.deepEqual(
    parseStoredVisitor(JSON.stringify({ ...visitor, hasConversation: "yes" })),
    { ...visitor, hasConversation: false },
  );
});

test("falls back to memory when storage is unavailable or throws", () => {
  for (const factory of [
    () => null,
    () => {
      throw new Error("SecurityError");
    },
    () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    }),
  ]) {
    const store = createVisitorStore(KEY, factory);
    assert.equal(store.persistent, false);
    store.write(visitor);
    assert.deepEqual(store.read(), visitor);
    store.clear();
    assert.equal(store.read(), null);
  }
});

test("switches to memory when storage starts failing mid-session", () => {
  const storage = memoryStorage();
  let broken = false;
  const flaky = {
    getItem: (key: string) => {
      if (broken) throw new Error("gone");
      return storage.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (broken) throw new Error("QuotaExceededError");
      storage.setItem(key, value);
    },
    removeItem: (key: string) => storage.removeItem(key),
  };
  const store = createVisitorStore(KEY, () => flaky);
  store.write(visitor);
  broken = true;
  const updated = { ...visitor, hasConversation: true };
  store.write(updated);
  assert.equal(store.persistent, false);
  assert.deepEqual(store.read(), updated);
});
