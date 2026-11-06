/**
 * The only module that imports @kontent-ai/data-ops. Everything else works with the
 * types re-exported here, so data-ops can be swapped (for example for our own
 * Management API applier) behind the same interface.
 *
 * The internal entry points are exposed by patches/@kontent-ai__data-ops@2.8.1.patch,
 * which only adds "exports" entries. scripts/check-data-ops.mjs guards the version.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSnapshot } from "@kontent-ai/data-ops";
import { type SyncDiffInternalResult, syncDiffInternal } from "@kontent-ai/data-ops/internal/diff";
import type { PatchOperation } from "@kontent-ai/data-ops/internal/patch-operation";
import { renderDiffReport } from "@kontent-ai/data-ops/internal/report";

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

export type DiffEngine = Readonly<{
  diff: (
    source: EnvironmentRef,
    target: EnvironmentRef,
    entities: ReadonlyArray<SelectableEntity>,
  ) => Promise<DiffModel>;
  renderReport: (
    diffModel: DiffModel,
    ids: Readonly<{ sourceEnvironmentId: string; targetEnvironmentId: string }>,
    entities: ReadonlyArray<SelectableEntity>,
  ) => string;
}>;

const commandName = "content-model-sync-app";

export const dataOpsDiffEngine: DiffEngine = {
  diff: async (source, target, entities) => {
    const { diffModel } = await syncDiffInternal(
      {
        sourceEnvironmentId: source.environmentId,
        sourceApiKey: source.apiKey,
        targetEnvironmentId: target.environmentId,
        targetApiKey: target.apiKey,
        entities,
        logLevel: "none",
      },
      commandName,
    );
    return diffModel;
  },

  renderReport: (diffModel, ids, entities) =>
    renderDiffReport({
      diffModel,
      params: {
        sourceEnvironmentId: ids.sourceEnvironmentId,
        targetEnvironmentId: ids.targetEnvironmentId,
        entities,
        noOpen: true,
        logLevel: "none",
      },
    }),
};

/** Snapshot files by name (for example "contentTypes.json"), parsed. */
export type SnapshotFiles = Readonly<Record<string, unknown>>;

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
