/**
 * The only module that imports @kontent-ai/data-ops. Everything else works with the
 * types re-exported here, so data-ops can be swapped (for example for our own
 * Management API applier) behind the same interface.
 *
 * The internal entry points are exposed by patches/@kontent-ai__data-ops@2.8.1.patch,
 * which only adds "exports" entries. scripts/check-data-ops.mjs guards the version.
 */
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
