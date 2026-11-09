import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { HttpError } from "../errors.js";
import { createInMemoryKvStore } from "../storage/kvStore.js";
import type { Analysis } from "../sync/analyze.js";
import type { PreparedDiff } from "../sync/diffService.js";
import { diffModel } from "../testing/diffModel.js";
import { clientEnvId, clientProjectId } from "../testing/fixtures.js";
import { createDriftService } from "./driftService.js";

const caller: Caller = { userId: "u1", email: "ada@example.com", name: "Ada", roles: [] };

const prepared = (analysis: Partial<Analysis>, excluded = 0): PreparedDiff => ({
  target: {
    environmentId: clientEnvId,
    environmentName: "Production",
    projectId: clientProjectId,
    projectName: "Client A",
    isMasterProject: false,
  },
  targetKey: "client-key",
  source: { kind: "master", environmentId: "m" },
  entities: ["contentTypes"],
  model: diffModel(),
  diffHash: "h",
  analysis: { changes: [], destructive: [], blocks: [], warnings: [], ...analysis },
  keptClientItems: [],
  excludedItems: Array.from({ length: excluded }, (_, i) => ({
    entity: "contentTypes" as const,
    codename: `x${i}`,
    kind: "updated" as const,
  })),
  selection: null,
});

const change = {
  entity: "Content type" as const,
  codename: "a",
  kind: "updated" as const,
  operations: [],
};

const setup = (prepare: () => Promise<PreparedDiff>) => {
  const kv = createInMemoryKvStore();
  const service = createDriftService({
    diff: { prepare: vi.fn(prepare) },
    kv,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
  });
  return { service, kv };
};

describe("drift service", () => {
  it("stores an in-sync result", async () => {
    const { service } = setup(async () => await Promise.resolve(prepared({})));

    const summary = await service.check(caller, clientEnvId.toUpperCase());

    expect(summary).toMatchObject({
      environmentId: clientEnvId,
      projectName: "Client A",
      status: "in_sync",
      changes: 0,
      checkedBy: { email: "ada@example.com" },
      entities: ["contentTypes", "contentTypeSnippets", "taxonomies"],
    });
    expect(await service.list()).toEqual([summary]);
  });

  it("counts drift, destructive changes and exclusions", async () => {
    const { service } = setup(
      async () =>
        await Promise.resolve(
          prepared(
            {
              changes: [change, { ...change, codename: "b" }],
              destructive: [
                {
                  id: "d1",
                  entity: "Content type",
                  owner: "a",
                  description: "",
                  count: null,
                  unknownReason: null,
                },
              ],
            },
            3,
          ),
        ),
    );

    expect(await service.check(caller, clientEnvId)).toMatchObject({
      status: "drift",
      changes: 2,
      destructive: 1,
      excluded: 3,
    });
  });

  it("reports blocked when the diff has blocks", async () => {
    const { service } = setup(
      async () =>
        await Promise.resolve(
          prepared({
            changes: [change],
            blocks: [{ entity: "Content type", owner: "a", reason: "r" }],
          }),
        ),
    );

    expect((await service.check(caller, clientEnvId)).status).toBe("blocked");
  });

  it("stores a failed check with a safe message and keeps the names", async () => {
    let fail = false;
    const { service } = setup(async () => {
      if (fail) {
        throw new Error("Bearer client-key");
      }
      return await Promise.resolve(prepared({}));
    });
    await service.check(caller, clientEnvId);
    fail = true;

    const summary = await service.check(caller, clientEnvId);

    expect(summary).toMatchObject({ status: "error", projectName: "Client A" });
    expect(summary.error).not.toContain("client-key");
  });

  it("does not store anything for the master or an unknown environment", async () => {
    const { service, kv } = setup(
      async () => await Promise.reject(new HttpError(403, "target_is_master", "Master")),
    );

    await expect(service.check(caller, clientEnvId)).rejects.toMatchObject({ status: 403 });
    await expect(service.check(caller, "nope")).rejects.toMatchObject({ status: 400 });
    expect(await kv.listKeys("drift/")).toEqual([]);
  });
});
