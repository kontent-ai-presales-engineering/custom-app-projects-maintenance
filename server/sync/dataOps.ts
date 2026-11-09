/**
 * The only module that imports @kontent-ai/data-ops. Everything else works with the
 * types re-exported here, so data-ops can be swapped (for example for our own
 * Management API applier) behind the same interface.
 *
 * The internal entry points are exposed by patches/@kontent-ai__data-ops@2.8.1.patch,
 * which only adds "exports" entries. scripts/check-data-ops.mjs guards the version.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSnapshot } from "@kontent-ai/data-ops";
import { createClient } from "@kontent-ai/data-ops/internal/client";
import { type SyncDiffInternalResult, syncDiffInternal } from "@kontent-ai/data-ops/internal/diff";
import type { PatchOperation } from "@kontent-ai/data-ops/internal/patch-operation";
import { renderDiffReport } from "@kontent-ai/data-ops/internal/report";
import { sync } from "@kontent-ai/data-ops/internal/sync";
import { validateTargetEnvironment } from "@kontent-ai/data-ops/internal/sync-run";

export type DiffModel = SyncDiffInternalResult["diffModel"];
export type { PatchOperation };

/** Entities the app lets the user choose. livePreview and assetFolders are not offered yet. */
export const selectableEntities = [
  "contentTypes",
  "contentTypeSnippets",
  "taxonomies",
  "collections",
  "spaces",
  "languages",
  "workflows",
] as const;

export type SelectableEntity = (typeof selectableEntities)[number];

/** Synced by default. The others are opt-in per sync. */
export const defaultEntities: ReadonlyArray<SelectableEntity> = [
  "contentTypes",
  "contentTypeSnippets",
  "taxonomies",
];

export type EnvironmentRef = Readonly<{ environmentId: string; apiKey: string }>;

/** Snapshot files by name (for example "contentTypes.json"), parsed. */
export type SnapshotFiles = Readonly<Record<string, unknown>>;

/** Where the desired model comes from: the master environment, or a stored backup (restore). */
export type DiffSource =
  | Readonly<{ kind: "environment"; environment: EnvironmentRef }>
  | Readonly<{ kind: "snapshot"; label: string; files: SnapshotFiles }>;

export type DiffEngine = Readonly<{
  diff: (
    source: DiffSource,
    target: EnvironmentRef,
    entities: ReadonlyArray<SelectableEntity>,
  ) => Promise<DiffModel>;
  renderReport: (
    diffModel: DiffModel,
    ids: Readonly<{ source: string; sourceIsEnvironment: boolean; targetEnvironmentId: string }>,
    entities: ReadonlyArray<SelectableEntity>,
  ) => string;
}>;

const commandName = "content-model-sync-app";

/** Snapshot file names data-ops reads. Anything else in a backup is not written to disk. */
const snapshotFileNames = new Set([
  "contentTypes.json",
  "contentTypeSnippets.json",
  "taxonomyGroups.json",
  "collections.json",
  "assetFolders.json",
  "spaces.json",
  "languages.json",
  "workflows.json",
  "livePreview.json",
  "metadata.json",
]);

/** Writes snapshot files to a fresh temporary folder, runs the action, and always removes it. */
export const withSnapshotFolder = async <T>(
  files: SnapshotFiles,
  action: (folder: string) => Promise<T>,
): Promise<T> => {
  const folder = await mkdtemp(join(tmpdir(), "model-restore-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      if (snapshotFileNames.has(name)) {
        await writeFile(join(folder, name), JSON.stringify(content));
      }
    }
    return await action(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

export const dataOpsDiffEngine: DiffEngine = {
  diff: async (source, target, entities) => {
    const targetParams = {
      targetEnvironmentId: target.environmentId,
      targetApiKey: target.apiKey,
      entities,
      logLevel: "none" as const,
    };
    if (source.kind === "environment") {
      const { diffModel } = await syncDiffInternal(
        {
          ...targetParams,
          sourceEnvironmentId: source.environment.environmentId,
          sourceApiKey: source.environment.apiKey,
        },
        commandName,
      );
      return diffModel;
    }
    return await withSnapshotFolder(source.files, async (folderName) => {
      const { diffModel } = await syncDiffInternal({ ...targetParams, folderName }, commandName);
      return diffModel;
    });
  },

  renderReport: (diffModel, ids, entities) =>
    renderDiffReport({
      diffModel,
      params: ids.sourceIsEnvironment
        ? {
            sourceEnvironmentId: ids.source,
            targetEnvironmentId: ids.targetEnvironmentId,
            entities,
            noOpen: true,
            logLevel: "none",
          }
        : {
            folderName: ids.source,
            targetEnvironmentId: ids.targetEnvironmentId,
            entities,
            noOpen: true,
            logLevel: "none",
          },
    }),
};

export type Snapshotter = Readonly<{
  /** Reads the full content model of an environment in data-ops' sync snapshot format. */
  snapshot: (environment: EnvironmentRef) => Promise<SnapshotFiles>;
}>;

/** Every entity a backup contains. livePreview is left out: it needs the Manage environments permission. */
const snapshotEntities = {
  contentTypes: () => true,
  contentTypeSnippets: () => true,
  taxonomies: () => true,
  collections: () => true,
  spaces: () => true,
  languages: () => true,
  workflows: () => true,
  assetFolders: () => true,
} as const;

type SnapshotRunner = (params: Parameters<typeof syncSnapshot>[0]) => Promise<void>;

/**
 * Runs data-ops' syncSnapshot into a fresh temporary folder (the only writable place in
 * a serverless function), reads the JSON files back, and always deletes the folder.
 */
export const createDataOpsSnapshotter = (run: SnapshotRunner = syncSnapshot): Snapshotter => ({
  snapshot: async (environment) => {
    const folder = await mkdtemp(join(tmpdir(), "model-backup-"));
    try {
      await run({
        environmentId: environment.environmentId,
        apiKey: environment.apiKey,
        entities: snapshotEntities,
        folderName: folder,
        logLevel: "none",
      });
      const names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort();
      const files: Record<string, unknown> = {};
      for (const name of names) {
        files[name] = JSON.parse(await readFile(join(folder, name), "utf8")) as unknown;
      }
      return files;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
});

const emptyDiffObject = () => ({ added: [], updated: new Map(), deleted: new Set<string>() });

/**
 * Keeps only the chosen entities' part of a diff and empties the rest. data-ops' own
 * syncRun filters the models the same way before diffing; syncDiffInternal does not,
 * so this makes the diff that is shown, hashed and applied cover exactly the choice.
 */
export const pickEntities = (
  model: DiffModel,
  entities: ReadonlyArray<SelectableEntity>,
): DiffModel => {
  const has = (entity: SelectableEntity) => entities.includes(entity);
  return {
    contentTypes: has("contentTypes") ? model.contentTypes : emptyDiffObject(),
    contentTypeSnippets: has("contentTypeSnippets") ? model.contentTypeSnippets : emptyDiffObject(),
    taxonomyGroups: has("taxonomies") ? model.taxonomyGroups : emptyDiffObject(),
    collections: has("collections") ? model.collections : [],
    spaces: has("spaces") ? model.spaces : emptyDiffObject(),
    languages: has("languages")
      ? model.languages
      : { ...emptyDiffObject(), inactiveTargetLanguageCodenames: new Set<string>() },
    workflows: has("workflows") ? model.workflows : { ...emptyDiffObject(), sourceWorkflows: [] },
    // Not offered in the app: never synced.
    assetFolders: [],
    livePreview: { change: "none" },
  };
};

const canonical = (value: unknown): unknown => {
  if (value instanceof Map) {
    return {
      map: [...(value as Map<string, unknown>).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    };
  }
  if (value instanceof Set) {
    return { set: [...(value as Set<string>)].sort() };
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/**
 * A stable fingerprint of exactly what a sync would apply. The confirmed diff and the
 * diff recomputed at sync time must have the same hash, or the sync stops.
 */
export const hashDiff = (
  model: DiffModel,
  context: Readonly<{
    sourceEnvironmentId: string;
    targetEnvironmentId: string;
    entities: ReadonlyArray<SelectableEntity>;
    /** The item selection, when the diff was restricted to chosen items. */
    items?: Readonly<Partial<Record<SelectableEntity, ReadonlyArray<string>>>> | undefined;
  }>,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        source: context.sourceEnvironmentId,
        target: context.targetEnvironmentId,
        items: canonical(context.items ?? null),
        entities: [...context.entities].sort(),
        model: canonical(model),
      }),
    )
    .digest("hex");

export type SyncEngine = Readonly<{
  /** data-ops' pre-sync validation. Returns the problems (codenames only), empty when valid. */
  validate: (target: EnvironmentRef, model: DiffModel) => Promise<ReadonlyArray<string>>;
  /** Applies the diff to the target. Not transactional: a failure can leave it partly applied. */
  apply: (
    target: EnvironmentRef,
    model: DiffModel,
    entities: ReadonlyArray<SelectableEntity>,
  ) => Promise<void>;
}>;

const clientFor = (target: EnvironmentRef) =>
  createClient({
    environmentId: target.environmentId,
    apiKey: target.apiKey,
    commandName,
    baseUrl: undefined,
  });

export const dataOpsSyncEngine: SyncEngine = {
  validate: async (target, model) => {
    try {
      await validateTargetEnvironment(model, clientFor(target));
      return [];
    } catch (error) {
      if (Array.isArray(error) && error.every((problem) => typeof problem === "string")) {
        return error as ReadonlyArray<string>;
      }
      throw error;
    }
  },

  apply: async (target, model, entities) => {
    await sync(clientFor(target), model, new Set(entities), { logLevel: "none" });
  },
};
