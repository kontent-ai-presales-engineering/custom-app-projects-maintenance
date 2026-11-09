import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { createAuditLog } from "../audit/auditLog.js";
import { keyVariableName } from "../keys/envKeys.js";
import { createInMemoryKvStore } from "../storage/kvStore.js";
import type { Snapshotter } from "../sync/dataOps.js";
import { clientEnvId, masterEnvId } from "../testing/fixtures.js";
import { createReleaseService } from "./releaseService.js";

const caller: Caller = { userId: "u1", email: "ada@example.com", name: "Ada", roles: [] };
const files = { "contentTypes.json": [{ codename: "article" }], "metadata.json": {} };

const setup = (
  options: Readonly<{ snapshotter?: Snapshotter; env?: Record<string, string> }> = {},
) => {
  const kv = createInMemoryKvStore();
  let tick = Date.parse("2026-11-09T10:00:00.000Z");
  const clock = () => {
    tick += 1000;
    return new Date(tick);
  };
  const audit = createAuditLog(kv, clock);
  const snapshotter = options.snapshotter ?? {
    snapshot: vi.fn(async () => await Promise.resolve(files)),
  };
  const service = createReleaseService({
    config: { masterEnvironmentId: masterEnvId },
    projects: {
      locate: async () =>
        await Promise.resolve({
          environmentId: masterEnvId,
          environmentName: "Production",
          projectId: "p-master",
          projectName: "Master",
          isMasterProject: true,
        }),
    },
    env: () => options.env ?? { [keyVariableName(masterEnvId)]: "master-key" },
    snapshotter,
    kv,
    audit,
    now: clock,
    log: vi.fn(),
  });
  return { service, audit, snapshotter, kv };
};

describe("release service", () => {
  it("snapshots the master with its key, stores the release and audits it", async () => {
    const { service, audit, snapshotter } = setup();

    const release = await service.create(caller, " v1 ", " First release ");

    expect(snapshotter.snapshot).toHaveBeenCalledWith({
      environmentId: masterEnvId,
      apiKey: "master-key",
    });
    expect(release).toMatchObject({
      version: "v1",
      notes: "First release",
      createdBy: { email: "ada@example.com" },
      counts: { "contentTypes.json": 1 },
    });
    expect((await service.get(release.id)).files).toEqual(files);
    expect((await audit.list(1))[0]).toMatchObject({
      action: "release.create",
      outcome: "succeeded",
      details: { version: "v1", releaseId: release.id },
    });
  });

  it("lists releases most recent first and refuses a duplicate version", async () => {
    const { service } = setup();
    await service.create(caller, "v1", "");
    await service.create(caller, "v2", "");

    expect((await service.list()).map((r) => r.version)).toEqual(["v2", "v1"]);
    await expect(service.create(caller, "V2", "")).rejects.toMatchObject({
      code: "version_exists",
    });
  });

  it.each(["", "v 1", "../x", "a".repeat(41)])("refuses the version %j", async (version) => {
    await expect(setup().service.create(caller, version, "")).rejects.toMatchObject({
      code: "invalid_version",
    });
  });

  it("asks for the master key and records a failed snapshot without details", async () => {
    await expect(setup({ env: {} }).service.create(caller, "v1", "")).rejects.toMatchObject({
      code: "key_missing",
    });

    const failing = setup({
      snapshotter: { snapshot: async () => await Promise.reject(new Error("Bearer master-key")) },
    });
    const error = await failing.service.create(caller, "v1", "").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "release_failed" });
    expect((error as Error).message).not.toContain("master-key");
    expect((await failing.audit.list(1))[0]?.outcome).toBe("failed");
  });

  it("refuses unknown or malformed release IDs", async () => {
    const { service } = setup();

    await expect(service.get("000001790000000-00000000")).rejects.toMatchObject({ status: 404 });
    await expect(service.get("../audit")).rejects.toMatchObject({ status: 404 });
  });

  it("records what each client environment was synced from", async () => {
    const { service } = setup();
    await service.recordClientRelease(caller, clientEnvId, { releaseId: "r1", version: "v1" });

    expect(await service.clientReleases()).toEqual({
      [clientEnvId]: {
        releaseId: "r1",
        version: "v1",
        syncedAt: expect.any(String) as string,
        syncedBy: { userId: "u1", email: "ada@example.com" },
      },
    });
  });
});
