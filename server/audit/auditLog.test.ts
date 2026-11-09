import { describe, expect, it } from "vitest";
import { createInMemoryKvStore } from "../storage/kvStore.js";
import { clientEnvId } from "../testing/fixtures.js";
import { createAuditLog, isAuditCursor } from "./auditLog.js";

const actor = { userId: "u1", email: "ada@example.com" };

const clock = () => {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  return () => {
    tick += 1000;
    return new Date(tick);
  };
};

describe("audit log", () => {
  it("records pending, then completes with the outcome", async () => {
    const audit = createAuditLog(createInMemoryKvStore(), clock());

    const event = await audit.begin({ actor, action: "sync.run", target: clientEnvId });
    expect((await audit.list(1))[0]?.outcome).toBe("pending");

    await audit.complete(event, "succeeded", { operations: 12 });
    expect((await audit.list(1))[0]).toMatchObject({
      action: "sync.run",
      target: clientEnvId,
      outcome: "succeeded",
      details: { operations: 12 },
      actor,
    });
  });

  it("lists the most recent entries first and respects the limit", async () => {
    const audit = createAuditLog(createInMemoryKvStore(), clock());
    await audit.begin({ actor, action: "backup.create", target: "a" });
    await audit.begin({ actor, action: "sync.run", target: "b" });
    await audit.begin({ actor, action: "sync.run", target: "c" });

    expect((await audit.list(2)).map((event) => event.target)).toEqual(["c", "b"]);
  });

  it("skips entries it cannot parse", async () => {
    const kv = createInMemoryKvStore();
    const audit = createAuditLog(kv, clock());
    await audit.begin({ actor, action: "sync.run", target: "ok" });
    await kv.setJson("audit/999999999999999-broken", { nonsense: true });

    expect((await audit.list(10)).map((event) => event.target)).toEqual(["ok"]);
  });
});

describe("audit log paging", () => {
  it("pages through entries with a cursor, most recent first", async () => {
    const audit = createAuditLog(createInMemoryKvStore(), clock());
    for (const target of ["a", "b", "c", "d", "e"]) {
      await audit.begin({ actor, action: "sync.run", target });
    }

    const first = await audit.listPage({ limit: 2 });
    expect(first.events.map((e) => e.target)).toEqual(["e", "d"]);
    expect(first.nextCursor).not.toBeNull();
    expect(isAuditCursor(first.nextCursor ?? "")).toBe(true);

    const second = await audit.listPage({ limit: 2, before: first.nextCursor ?? undefined });
    expect(second.events.map((e) => e.target)).toEqual(["c", "b"]);

    const last = await audit.listPage({ limit: 2, before: second.nextCursor ?? undefined });
    expect(last.events.map((e) => e.target)).toEqual(["a"]);
    expect(last.nextCursor).toBeNull();
  });

  it("rejects malformed cursors", () => {
    expect(isAuditCursor("../secrets")).toBe(false);
    expect(isAuditCursor("")).toBe(false);
  });
});
