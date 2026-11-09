import { describe, expect, it, vi } from "vitest";
import type { PreparedDiff } from "../sync/diffService.js";
import { diffModel } from "../testing/diffModel.js";
import { clientEnvId, clientProjectId } from "../testing/fixtures.js";
import { createRolloutService } from "./rolloutService.js";

const prepared = (overrides: Partial<PreparedDiff["analysis"]> = {}): PreparedDiff => ({
  target: {
    environmentId: clientEnvId,
    environmentName: "Dev",
    projectId: clientProjectId,
    projectName: "Client A",
    isMasterProject: false,
  },
  targetKey: "client-key",
  source: { kind: "master", environmentId: "m" },
  entities: ["contentTypes"],
  model: diffModel(),
  diffHash: "a".repeat(64),
  analysis: { changes: [], destructive: [], blocks: [], warnings: [], ...overrides },
  keptClientItems: [],
  excludedItems: [],
  selection: null,
});

const change = {
  entity: "Content type" as const,
  codename: "a",
  kind: "updated" as const,
  operations: [],
};

const setup = (diff: PreparedDiff, info: () => Promise<{ is_production?: boolean }>) => {
  const getEnvironmentInfo = vi.fn(async () => {
    const result = await info();
    return { id: clientEnvId, name: "Client A", environment: "Dev", ...result };
  });
  const managementClient = vi.fn(() => ({ getEnvironmentInfo }));
  const service = createRolloutService({
    diff: { prepare: async () => await Promise.resolve(diff) },
    managementClient,
  });
  return { service, managementClient };
};

describe("rollout plan", () => {
  it("plans a non-production environment with its fingerprint", async () => {
    const { service, managementClient } = setup(
      prepared({ changes: [change] }),
      async () => await Promise.resolve({ is_production: false }),
    );

    expect(await service.plan(clientEnvId, ["contentTypes"])).toMatchObject({
      environmentId: clientEnvId,
      projectName: "Client A",
      isProduction: false,
      stage: "non-production",
      status: "ready",
      changes: 1,
      diffHash: "a".repeat(64),
    });
    expect(managementClient).toHaveBeenCalledWith(clientEnvId, "client-key");
  });

  it("puts production, and environments of unknown kind, in the production stage", async () => {
    const production = setup(
      prepared({ changes: [change] }),
      async () => await Promise.resolve({ is_production: true }),
    );
    const unknown = setup(
      prepared({ changes: [change] }),
      async () => await Promise.reject(new Error("403")),
    );

    expect((await production.service.plan(clientEnvId, ["contentTypes"])).stage).toBe("production");
    const entry = await unknown.service.plan(clientEnvId, ["contentTypes"]);
    expect(entry.isProduction).toBeNull();
    expect(entry.stage).toBe("production");
  });

  it("marks blocked and in-sync environments", async () => {
    const blocked = setup(
      prepared({
        changes: [change],
        blocks: [{ entity: "Content type", owner: "a", reason: "r" }],
      }),
      async () => await Promise.resolve({ is_production: false }),
    );
    const inSync = setup(prepared(), async () => await Promise.resolve({ is_production: false }));

    const blockedEntry = await blocked.service.plan(clientEnvId, ["contentTypes"]);
    expect(blockedEntry.status).toBe("blocked");
    expect(blockedEntry.blocks).toEqual(["Content type a: r"]);
    expect((await inSync.service.plan(clientEnvId, ["contentTypes"])).status).toBe("in_sync");
  });

  it("never returns the key", async () => {
    const { service } = setup(
      prepared({ changes: [change] }),
      async () => await Promise.resolve({ is_production: false }),
    );

    expect(JSON.stringify(await service.plan(clientEnvId, ["contentTypes"]))).not.toContain(
      "client-key",
    );
  });
});
