import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { createAuditLog } from "../audit/auditLog.js";
import type { BackupService } from "../backup/backupService.js";
import { keyVariableName } from "../keys/envKeys.js";
import type { ManagementClient, ModelType } from "../kontent/managementClient.js";
import type { LocatedEnvironment } from "../projects/projectService.js";
import type { ReleaseService } from "../releases/releaseService.js";
import { createInMemoryKvStore, type KvStore } from "../storage/kvStore.js";
import { addInto, diffModel, remove } from "../testing/diffModel.js";
import { clientEnvId, clientProjectId, masterEnvId } from "../testing/fixtures.js";
import {
  type DiffEngine,
  type DiffModel,
  hashDiff,
  type SelectableEntity,
  type SyncEngine,
  selectableEntities,
} from "./dataOps.js";
import { createDiffService } from "./diffService.js";
import type { Exclusions } from "./selection.js";
import { createSyncService, type SyncRequest } from "./syncService.js";

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

const article: ModelType = {
  id: "t-article",
  codename: "article",
  elements: [{ id: "e-summary", codename: "summary", type: "text" }],
};

const management: ManagementClient = {
  getEnvironmentInfo: async () => Promise.reject(new Error("unused")),
  checkContentModelAccess: async () => Promise.resolve(),
  listTypes: async () => Promise.resolve([article]),
  listSnippets: async () => Promise.resolve([]),
  listTaxonomies: async () => Promise.resolve([]),
  listLanguages: async () => Promise.resolve([]),
  listVariantsOfType: async () => Promise.resolve([]),
  isUsedAsComponent: async () => Promise.resolve(false),
  countItems: async () => Promise.resolve(0),
};

/** A diff with an addition in every selectable entity. */
const everyEntityModel = (): DiffModel =>
  diffModel({
    contentTypes: { updated: { article: [addInto("/elements", { codename: "subtitle" })] } },
    contentTypeSnippets: { added: [{ codename: "seo" }] },
    taxonomyGroups: { added: [{ codename: "tags" }] },
    spaces: { added: [{ codename: "web" }] },
    languages: { added: [{ codename: "nl" }] },
    workflows: { added: [{ codename: "review" }] },
    collections: [addInto("", { codename: "brand" })],
  });

type Setup = Readonly<{
  model?: () => DiffModel;
  validate?: SyncEngine["validate"];
  apply?: SyncEngine["apply"];
  backup?: BackupService["create"];
  kv?: KvStore;
  now?: () => Date;
  backupGet?: BackupService["get"];
  exclusions?: Exclusions;
  releaseGet?: ReleaseService["get"];
}>;

const setup = (options: Setup = {}) => {
  let currentModel =
    options.model ??
    (() =>
      diffModel({
        contentTypes: { updated: { article: [addInto("/elements", { codename: "subtitle" })] } },
      }));
  const diffEngine: DiffEngine = {
    diff: async () => Promise.resolve(currentModel()),
    renderReport: () => "<html></html>",
  };
  const diff = createDiffService({
    config: { masterEnvironmentId: masterEnvId, clientPrefix: "client_" },
    backups: {
      get: options.backupGet ?? (async () => Promise.reject(new Error("unknown backup"))),
    },
    releases: {
      get: options.releaseGet ?? (async () => Promise.reject(new Error("unknown release"))),
    },
    exclusions: {
      get: async (projectId) =>
        await Promise.resolve({
          projectId,
          items: options.exclusions ?? {},
          updatedAt: null,
          updatedBy: null,
        }),
    },
    projects: {
      locate: async (id) => {
        const env = located[id];
        if (env === undefined) {
          throw new Error("unknown");
        }
        return await Promise.resolve(env);
      },
    },
    env: () => ({
      [keyVariableName(masterEnvId)]: "master-key",
      [keyVariableName(clientEnvId)]: "client-key",
    }),
    engine: diffEngine,
    managementClient: () => management,
    deliveryClient: () => ({ publishedItems: async () => Promise.resolve([]) }),
    log: vi.fn(),
  });
  const kv = options.kv ?? createInMemoryKvStore();
  let tick = Date.parse("2026-11-06T10:00:00.000Z");
  const clock =
    options.now ??
    (() => {
      tick += 1000;
      return new Date(tick);
    });
  const audit = createAuditLog(kv, clock);
  const calls: string[] = [];
  const backup = vi.fn(
    options.backup ??
      (async () => {
        calls.push("backup");
        return await Promise.resolve({ id: "000001790000000-abcdef12" } as Awaited<
          ReturnType<BackupService["create"]>
        >);
      }),
  );
  const recordClientRelease = vi.fn(async () => {
    await Promise.resolve();
  });
  const engine: SyncEngine = {
    validate: vi.fn(
      options.validate ??
        (async () => {
          calls.push("validate");
          return await Promise.resolve([]);
        }),
    ),
    apply: vi.fn(
      options.apply ??
        (async () => {
          calls.push("apply");
          await Promise.resolve();
        }),
    ),
  };
  const service = createSyncService({
    diff,
    backups: { create: backup },
    releases: { recordClientRelease },
    engine,
    kv,
    audit,
    now: clock,
    log: vi.fn(),
  });
  const confirmed = async (entities: ReadonlyArray<SelectableEntity> = ["contentTypes"]) => {
    const result = await diff.diff(clientEnvId, { entities });
    const request: SyncRequest = {
      environmentId: clientEnvId,
      entities,
      diffHash: result.diffHash,
      confirmProjectName: "Client A",
      confirmDestructive: false,
    };
    return { result, request };
  };
  return {
    service,
    recordClientRelease,
    diff,
    engine,
    backup,
    audit,
    kv,
    calls,
    confirmed,
    setModel: (next: () => DiffModel) => {
      currentModel = next;
    },
  };
};

describe("sync service", () => {
  it("backs up, validates and applies the confirmed diff, then audits", async () => {
    const s = setup();
    const { request } = await s.confirmed();

    const outcome = await s.service.sync(caller, request);

    expect(outcome).toEqual({
      status: "succeeded",
      backupId: "000001790000000-abcdef12",
      operations: 1,
      projectName: "Client A",
      environmentName: "Production",
    });
    expect(s.calls).toEqual(["backup", "validate", "apply"]);
    expect(s.backup).toHaveBeenCalledWith(caller, clientEnvId, "pre-sync");
    expect(vi.mocked(s.engine.apply).mock.calls[0]?.[0]).toEqual({
      environmentId: clientEnvId,
      apiKey: "client-key",
    });
    expect((await s.audit.list(1))[0]).toMatchObject({
      action: "sync.run",
      target: clientEnvId,
      outcome: "succeeded",
      details: { backupId: "000001790000000-abcdef12", operations: 1, entities: "contentTypes" },
    });
    expect(await s.kv.listKeys("locks/")).toEqual([]);
  });

  it("stops without changes when the diff changed after confirmation", async () => {
    const s = setup();
    const { request } = await s.confirmed();
    s.setModel(() =>
      diffModel({ contentTypes: { updated: { article: [remove("/elements/codename:summary")] } } }),
    );

    await expect(s.service.sync(caller, request)).rejects.toMatchObject({
      status: 409,
      code: "diff_changed",
    });
    expect(s.calls).toEqual([]);
  });

  it("requires the exact project name", async () => {
    const s = setup();
    const { request } = await s.confirmed();

    await expect(
      s.service.sync(caller, { ...request, confirmProjectName: "client a" }),
    ).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
    expect(s.calls).toEqual([]);
  });

  it("requires explicit confirmation of destructive changes", async () => {
    const s = setup({
      model: () =>
        diffModel({
          contentTypes: { updated: { article: [remove("/elements/codename:summary")] } },
        }),
    });
    const { request } = await s.confirmed();

    await expect(s.service.sync(caller, request)).rejects.toMatchObject({
      code: "destructive_not_confirmed",
    });
    expect(s.calls).toEqual([]);

    await expect(
      s.service.sync(caller, { ...request, confirmDestructive: true }),
    ).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("refuses a blocked diff", async () => {
    const s = setup({
      model: () =>
        diffModel({ workflows: { updated: { default: [remove("/steps/codename:review")] } } }),
    });
    const { request } = await s.confirmed(["workflows"]);

    await expect(
      s.service.sync(caller, { ...request, confirmDestructive: true }),
    ).rejects.toMatchObject({ status: 409, code: "blocked" });
    expect(s.calls).toEqual([]);
  });

  it("does nothing when already in sync", async () => {
    const s = setup({ model: () => diffModel() });
    const { request } = await s.confirmed();

    expect(await s.service.sync(caller, request)).toEqual({ status: "nothing_to_sync" });
    expect(s.calls).toEqual([]);
  });

  it("refuses a second sync to the same environment while one is running", async () => {
    const kv = createInMemoryKvStore();
    await kv.setJson(`locks/sync/${clientEnvId}`, {
      holder: "otto@example.com",
      acquiredAt: "2026-11-06T10:00:30.000Z",
    });
    const s = setup({ kv });
    const { request } = await s.confirmed();

    await expect(s.service.sync(caller, request)).rejects.toMatchObject({
      status: 409,
      code: "sync_in_progress",
    });
    expect(s.calls).toEqual([]);
  });

  it("takes over a lock older than 15 minutes", async () => {
    const kv = createInMemoryKvStore();
    await kv.setJson(`locks/sync/${clientEnvId}`, {
      holder: "otto@example.com",
      acquiredAt: "2026-11-06T09:00:00.000Z",
    });
    const s = setup({ kv });
    const { request } = await s.confirmed();

    await expect(s.service.sync(caller, request)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("does not apply when the backup fails, and releases the lock", async () => {
    const s = setup({ backup: async () => Promise.reject(new Error("backup failed")) });
    const { request } = await s.confirmed();

    await expect(s.service.sync(caller, request)).rejects.toThrow("backup failed");
    expect(s.engine.apply).not.toHaveBeenCalled();
    expect((await s.audit.list(1))[0]).toMatchObject({
      outcome: "failed",
      details: { stage: "backup" },
    });
    expect(await s.kv.listKeys("locks/")).toEqual([]);
  });

  it("reports data-ops validation problems without applying", async () => {
    const problems = ["Content type (codename: page) is being used and can't be removed"];
    const s = setup({ validate: async () => Promise.resolve(problems) });
    const { request } = await s.confirmed();

    expect(await s.service.sync(caller, request)).toEqual({
      status: "validation_failed",
      backupId: "000001790000000-abcdef12",
      problems,
    });
    expect(s.engine.apply).not.toHaveBeenCalled();
  });

  it("explains a partial sync and points to the backup", async () => {
    const s = setup({ apply: async () => Promise.reject(new Error("Bearer client-key 500")) });
    const { request } = await s.confirmed();

    const error = await s.service.sync(caller, request).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: "sync_failed" });
    expect((error as Error).message).toContain("000001790000000-abcdef12");
    expect((error as Error).message).not.toContain("client-key");
    expect((await s.audit.list(1))[0]).toMatchObject({
      outcome: "failed",
      details: { stage: "apply", error: "Error" },
    });
    expect(await s.kv.listKeys("locks/")).toEqual([]);
  });
});

/** Every non-empty combination of the selectable entities. */
const combinations = (): ReadonlyArray<ReadonlyArray<SelectableEntity>> =>
  Array.from({ length: 2 ** selectableEntities.length - 1 }, (_, i) =>
    selectableEntities.filter((_e, bit) => ((i + 1) & (1 << bit)) !== 0),
  );

const partFor: Record<SelectableEntity, (m: DiffModel) => number> = {
  contentTypes: (m) => m.contentTypes.updated.size + m.contentTypes.added.length,
  contentTypeSnippets: (m) => m.contentTypeSnippets.added.length,
  taxonomies: (m) => m.taxonomyGroups.added.length,
  collections: (m) => m.collections.length,
  spaces: (m) => m.spaces.added.length,
  languages: (m) => m.languages.added.length,
  workflows: (m) => m.workflows.added.length,
};

describe("diff and sync use the same operations for every entity combination", () => {
  it.each(
    combinations().map((entities) => [entities.join("+"), entities] as const),
  )("%s", async (_label, entities) => {
    const s = setup({ model: everyEntityModel });
    const { result, request } = await s.confirmed(entities);

    await s.service.sync(caller, request);

    const [ref, applied, appliedEntities] = vi.mocked(s.engine.apply).mock.calls[0] ?? [];
    expect(ref?.environmentId).toBe(clientEnvId);
    expect(appliedEntities).toEqual(entities);
    // The applied model is byte-for-byte the confirmed one...
    expect(
      hashDiff(applied as DiffModel, {
        sourceEnvironmentId: masterEnvId,
        targetEnvironmentId: clientEnvId,
        entities,
      }),
    ).toBe(result.diffHash);
    // ...and holds operations for the chosen entities only.
    for (const entity of selectableEntities) {
      expect(partFor[entity](applied as DiffModel) > 0).toBe(entities.includes(entity));
    }
    // The summary shown to the user lists the same entities.
    expect(new Set(result.changes.map((c) => c.entity)).size).toBe(entities.length);
  });
});

describe("restore from a backup", () => {
  const backupId = "000001790000000-abcdef12";
  const backupFiles = { "contentTypes.json": [{ codename: "article" }] };
  const backupGet: BackupService["get"] = async (environmentId, id) => {
    if (environmentId !== clientEnvId || id !== backupId) {
      throw new Error("not found");
    }
    return await Promise.resolve({
      metadata: {
        id: backupId,
        environmentId: clientEnvId,
        environmentName: "Production",
        projectId: clientProjectId,
        projectName: "Client A",
        createdAt: "2026-11-01T09:00:00.000Z",
        createdBy: { userId: "u1", email: "ada@example.com" },
        reason: "pre-sync",
        counts: {},
      },
      files: backupFiles,
    });
  };

  it("compares the client with its backup, not the master", async () => {
    const s = setup({
      backupGet,
      // A backup legitimately contains client items: no master prefix block.
      model: () => diffModel({ contentTypes: { added: [{ codename: "client_promo" }] } }),
    });

    const result = await s.diff.diff(clientEnvId, {
      entities: ["contentTypes"],
      restoreFrom: backupId,
    });

    expect(result.source).toEqual({
      kind: "backup",
      backupId,
      createdAt: "2026-11-01T09:00:00.000Z",
    });
    expect(result.blocks).toEqual([]);
    expect(result.changes.map((c) => c.codename)).toEqual(["client_promo"]);
  });

  it("restores with a fresh backup first and audits it as a restore", async () => {
    const s = setup({ backupGet });
    const result = await s.diff.diff(clientEnvId, {
      entities: ["contentTypes"],
      restoreFrom: backupId,
    });

    const outcome = await s.service.sync(caller, {
      environmentId: clientEnvId,
      entities: ["contentTypes"],
      diffHash: result.diffHash,
      confirmProjectName: "Client A",
      confirmDestructive: false,
      restoreFrom: backupId,
    });

    expect(outcome.status).toBe("succeeded");
    expect(s.backup).toHaveBeenCalledWith(caller, clientEnvId, "pre-restore");
    expect((await s.audit.list(1))[0]).toMatchObject({
      action: "backup.restore",
      outcome: "succeeded",
      details: { restoredBackupId: backupId },
    });
  });

  it("does not accept the hash of a master diff for a restore", async () => {
    const s = setup({ backupGet });
    const masterDiff = await s.diff.diff(clientEnvId, { entities: ["contentTypes"] });

    await expect(
      s.service.sync(caller, {
        environmentId: clientEnvId,
        entities: ["contentTypes"],
        diffHash: masterDiff.diffHash,
        confirmProjectName: "Client A",
        confirmDestructive: false,
        restoreFrom: backupId,
      }),
    ).rejects.toMatchObject({ code: "diff_changed" });
    expect(s.calls).toEqual([]);
  });

  it("refuses a backup that does not belong to the environment", async () => {
    const s = setup({ backupGet });

    await expect(
      s.diff.diff(clientEnvId, {
        entities: ["contentTypes"],
        restoreFrom: "000001790000000-00000000",
      }),
    ).rejects.toThrow("not found");
  });
});

describe("selective sync", () => {
  it("applies exactly the selected items and their dependencies, and binds the selection to the hash", async () => {
    const s = setup({
      model: () =>
        diffModel({
          contentTypes: {
            added: [
              { codename: "event", elements: [{ type: "snippet", snippet: { codename: "seo" } }] },
              { codename: "page", elements: [] },
            ],
          },
          contentTypeSnippets: { added: [{ codename: "seo", elements: [] }] },
        }),
    });
    const items = { contentTypes: ["event"], contentTypeSnippets: [] };
    const result = await s.diff.diff(clientEnvId, {
      entities: ["contentTypes", "contentTypeSnippets"],
      items,
    });

    expect(result.selection?.dependencies.map((d) => d.codename)).toEqual(["seo"]);
    expect(result.changes.map((c) => c.codename)).toEqual(["event", "seo"]);

    const request: SyncRequest = {
      environmentId: clientEnvId,
      entities: ["contentTypes", "contentTypeSnippets"],
      diffHash: result.diffHash,
      confirmProjectName: "Client A",
      confirmDestructive: false,
      items,
    };

    // The same hash without the selection is a different diff.
    await expect(s.service.sync(caller, { ...request, items: undefined })).rejects.toMatchObject({
      code: "diff_changed",
    });

    await s.service.sync(caller, request);
    const applied = vi.mocked(s.engine.apply).mock.calls[0]?.[1];
    expect(applied?.contentTypes.added.map((t) => t.codename)).toEqual(["event"]);
    expect(applied?.contentTypeSnippets.added.map((t) => t.codename)).toEqual(["seo"]);
  });
});

describe("client exclusions", () => {
  const twoTypes = () =>
    diffModel({
      contentTypes: {
        updated: {
          article: [addInto("/elements", { codename: "subtitle" })],
          page: [addInto("/elements", { codename: "intro" })],
        },
      },
    });

  it("never applies changes to excluded items", async () => {
    const s = setup({ model: twoTypes, exclusions: { contentTypes: ["article"] } });
    const { result, request } = await s.confirmed();

    expect(result.excludedItems).toEqual([
      { entity: "contentTypes", codename: "article", kind: "updated" },
    ]);
    expect(result.changes.map((c) => c.codename)).toEqual(["page"]);

    await s.service.sync(caller, request);
    const applied = vi.mocked(s.engine.apply).mock.calls[0]?.[1];
    expect([...(applied?.contentTypes.updated.keys() ?? [])]).toEqual(["page"]);
  });

  it("blocks when a synced item needs an excluded one", async () => {
    const s = setup({
      model: () =>
        diffModel({
          contentTypes: {
            added: [{ codename: "event", elements: [{ snippet: { codename: "seo" } }] }],
          },
          contentTypeSnippets: { added: [{ codename: "seo", elements: [] }] },
        }),
      exclusions: { contentTypeSnippets: ["seo"] },
    });
    const { result } = await s.confirmed(["contentTypes", "contentTypeSnippets"]);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.reason).toContain('snippet "seo"');
  });
});

describe("exclusions and restore", () => {
  it("does not apply exclusions when restoring a backup", async () => {
    const backupId = "000001790000000-abcdef12";
    const s = setup({
      model: () =>
        diffModel({
          contentTypes: { updated: { article: [addInto("/elements", { codename: "x" })] } },
        }),
      exclusions: { contentTypes: ["article"] },
      backupGet: async () =>
        await Promise.resolve({
          metadata: {
            id: backupId,
            environmentId: clientEnvId,
            environmentName: "Production",
            projectId: clientProjectId,
            projectName: "Client A",
            createdAt: "2026-11-01T09:00:00.000Z",
            createdBy: { userId: "u1", email: "ada@example.com" },
            reason: "manual",
            counts: {},
          },
          files: {},
        }),
    });

    const result = await s.diff.diff(clientEnvId, {
      entities: ["contentTypes"],
      restoreFrom: backupId,
    });

    expect(result.excludedItems).toEqual([]);
    expect(result.changes.map((c) => c.codename)).toEqual(["article"]);
  });
});

describe("syncing from a master release", () => {
  const releaseId = "000001790000000-12345678";
  const releaseGet: ReleaseService["get"] = async (id) => {
    if (id !== releaseId) {
      throw new Error("release not found");
    }
    return await Promise.resolve({
      metadata: {
        id: releaseId,
        version: "v3",
        notes: "Adds the event type",
        createdAt: "2026-11-08T09:00:00.000Z",
        createdBy: { userId: "u1", email: "ada@example.com" },
        counts: {},
      },
      files: { "contentTypes.json": [] },
    });
  };

  it("compares with the release and applies exclusions and the prefix rule like the master", async () => {
    const s = setup({
      releaseGet,
      exclusions: { contentTypes: ["article"] },
      model: () =>
        diffModel({
          contentTypes: {
            added: [{ codename: "client_promo" }],
            updated: { article: [addInto("/elements", { codename: "x" })] },
          },
        }),
    });

    const result = await s.diff.diff(clientEnvId, {
      entities: ["contentTypes"],
      release: releaseId,
    });

    expect(result.source).toEqual({
      kind: "release",
      releaseId,
      version: "v3",
      createdAt: "2026-11-08T09:00:00.000Z",
    });
    expect(result.excludedItems.map((i) => i.codename)).toEqual(["article"]);
    expect(result.blocks[0]?.reason).toContain("client_promo");
  });

  it("records the release on the client after a successful sync, and audits the version", async () => {
    const s = setup({ releaseGet });
    const result = await s.diff.diff(clientEnvId, {
      entities: ["contentTypes"],
      release: releaseId,
    });

    await s.service.sync(caller, {
      environmentId: clientEnvId,
      entities: ["contentTypes"],
      diffHash: result.diffHash,
      confirmProjectName: "Client A",
      confirmDestructive: false,
      release: releaseId,
    });

    expect(s.recordClientRelease).toHaveBeenCalledWith(caller, clientEnvId, {
      releaseId,
      version: "v3",
    });
    expect((await s.audit.list(1))[0]?.details).toMatchObject({ release: "v3" });
  });

  it("records live master after a normal sync", async () => {
    const s = setup();
    const { request } = await s.confirmed();
    await s.service.sync(caller, request);

    expect(s.recordClientRelease).toHaveBeenCalledWith(caller, clientEnvId, null);
  });

  it("does not accept a live-master fingerprint for a release sync", async () => {
    const s = setup({ releaseGet });
    const { request } = await s.confirmed();

    await expect(s.service.sync(caller, { ...request, release: releaseId })).rejects.toMatchObject({
      code: "diff_changed",
    });
  });

  it("refuses a release and a backup together", async () => {
    const s = setup({ releaseGet });

    await expect(
      s.diff.diff(clientEnvId, {
        entities: ["contentTypes"],
        release: releaseId,
        restoreFrom: "000001790000000-abcdef12",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
