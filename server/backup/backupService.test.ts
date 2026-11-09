import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { createAuditLog } from "../audit/auditLog.js";
import { keyVariableName } from "../keys/envKeys.js";
import type { LocatedEnvironment } from "../projects/projectService.js";
import { createInMemoryKvStore, type KvStore } from "../storage/kvStore.js";
import type { Snapshotter } from "../sync/dataOps.js";
import { clientEnvId, clientProjectId, masterEnvId } from "../testing/fixtures.js";
import { createBackupService } from "./backupService.js";

const caller: Caller = { userId: "u1", email: "ada@example.com", name: "Ada", roles: [] };

const located: Record<string, LocatedEnvironment> = {
  [masterEnvId]: {
    environmentId: masterEnvId,
    environmentName: "Production",
    projectId: "p-master",
    projectName: "Master",
    isMasterProject: true,
  },
  [clientEnvId]: {
    environmentId: clientEnvId,
    environmentName: "Production",
    projectId: clientProjectId,
    projectName: "Client A",
    isMasterProject: false,
  },
};

const files = {
  "contentTypes.json": [{ codename: "article" }, { codename: "page" }],
  "taxonomyGroups.json": [{ codename: "tags" }],
  "metadata.json": { generatedAt: "x" },
};

const setup = (
  options: Readonly<{
    snapshotter?: Snapshotter;
    env?: Record<string, string>;
    kv?: KvStore & { raw?: Map<string, string> };
  }> = {},
) => {
  const kv = options.kv ?? createInMemoryKvStore();
  let tick = Date.parse("2026-11-06T10:00:00.000Z");
  const clock = () => {
    tick += 1000;
    return new Date(tick);
  };
  const audit = createAuditLog(kv, clock);
  const snapshotter = options.snapshotter ?? {
    snapshot: vi.fn(async () => Promise.resolve(files)),
  };
  const service = createBackupService({
    config: { masterEnvironmentId: masterEnvId },
    projects: {
      locate: async (id) => {
        const env = located[id];
        if (env === undefined) {
          throw new Error("unknown");
        }
        return await Promise.resolve(env);
      },
    },
    env: () => options.env ?? { [keyVariableName(clientEnvId)]: "client-key" },
    snapshotter,
    kv,
    audit,
    now: clock,
    log: vi.fn(),
  });
  return { service, kv, audit, snapshotter };
};

describe("backup service", () => {
  it("snapshots with the client key, stores data and index, and audits", async () => {
    const { service, snapshotter, audit } = setup();

    const metadata = await service.create(caller, clientEnvId.toUpperCase(), "manual");

    expect(snapshotter.snapshot).toHaveBeenCalledWith({
      environmentId: clientEnvId,
      apiKey: "client-key",
    });
    expect(metadata).toMatchObject({
      environmentId: clientEnvId,
      projectName: "Client A",
      createdBy: { userId: "u1", email: "ada@example.com" },
      reason: "manual",
      counts: { "contentTypes.json": 2, "taxonomyGroups.json": 1 },
    });
    expect(metadata.id).toMatch(/^\d{15}-[0-9a-f]{8}$/);

    const backup = await service.get(clientEnvId, metadata.id);
    expect(backup.files).toEqual(files);

    const [event] = await audit.list(1);
    expect(event).toMatchObject({
      action: "backup.create",
      target: clientEnvId,
      outcome: "succeeded",
      details: { backupId: metadata.id, reason: "manual" },
    });
  });

  it("never stores the key", async () => {
    const { service, kv } = setup();
    await service.create(caller, clientEnvId, "manual");

    expect([...(kv as ReturnType<typeof createInMemoryKvStore>).raw.values()].join()).not.toContain(
      "client-key",
    );
  });

  it("lists backups most recent first", async () => {
    const { service } = setup();
    const first = await service.create(caller, clientEnvId, "manual");
    const second = await service.create(caller, clientEnvId, "pre-sync");

    expect((await service.list(clientEnvId)).map((b) => b.id)).toEqual([second.id, first.id]);
  });

  it("refuses master-project environments", async () => {
    const { service, snapshotter } = setup();

    await expect(service.create(caller, masterEnvId, "manual")).rejects.toMatchObject({
      status: 403,
      code: "target_is_master",
    });
    expect(snapshotter.snapshot).not.toHaveBeenCalled();
  });

  it("asks for a key when none is configured", async () => {
    await expect(
      setup({ env: {} }).service.create(caller, clientEnvId, "manual"),
    ).rejects.toMatchObject({
      status: 409,
      code: "key_missing",
    });
  });

  it("records a failed backup and stores nothing", async () => {
    const { service, audit, kv } = setup({
      snapshotter: { snapshot: async () => Promise.reject(new Error("Bearer client-key")) },
    });

    const error = await service.create(caller, clientEnvId, "manual").catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: "backup_failed" });
    expect((error as Error).message).not.toContain("client-key");
    expect((await audit.list(1))[0]).toMatchObject({
      outcome: "failed",
      details: { error: "Error" },
    });
    expect(await kv.listKeys("backups/")).toEqual([]);
  });

  it("does not back up when the audit entry cannot be written", async () => {
    const base = createInMemoryKvStore();
    const failing: KvStore = {
      ...base,
      setJson: async (key, value) => {
        if (key.startsWith("audit/")) {
          throw new Error("blob down");
        }
        await base.setJson(key, value);
      },
    };
    const { service, snapshotter } = setup({ kv: failing });

    await expect(service.create(caller, clientEnvId, "manual")).rejects.toThrow("blob down");
    expect(snapshotter.snapshot).not.toHaveBeenCalled();
  });

  it("does not return a backup for another environment or a malformed ID", async () => {
    const { service } = setup();
    const metadata = await service.create(caller, clientEnvId, "manual");

    await expect(
      service.get("44444444-4444-4444-4444-444444444444", metadata.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.get(clientEnvId, "../../audit/x")).rejects.toMatchObject({ status: 404 });
  });
});
