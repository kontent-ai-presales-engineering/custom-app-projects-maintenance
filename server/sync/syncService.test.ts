import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { createAuditLog } from "../audit/auditLog.js";
import type { BackupService } from "../backup/backupService.js";
import { keyVariableName } from "../keys/envKeys.js";
import type { ManagementClient, ModelType } from "../kontent/managementClient.js";
import type { LocatedEnvironment } from "../projects/projectService.js";
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
    engine,
    kv,
    audit,
    now: clock,
    log: vi.fn(),
  });
  const confirmed = async (entities: ReadonlyArray<SelectableEntity> = ["contentTypes"]) => {
    const result = await diff.diff(clientEnvId, entities);
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
