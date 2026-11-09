import type { BackupService } from "../backup/backupService.js";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { ExclusionService } from "../exclusions/exclusionService.js";
import { resolveDeliveryKey, resolveManagementKey } from "../keys/envKeys.js";
import type { DeliveryClient } from "../kontent/deliveryClient.js";
import type { ManagementClient } from "../kontent/managementClient.js";
import type { LocatedEnvironment, ProjectService } from "../projects/projectService.js";
import type { ReleaseService } from "../releases/releaseService.js";
import {
  type Analysis,
  analyzeDiff,
  type Block,
  type EntityChange,
  type Warning,
} from "./analyze.js";
import { dropPrefixedRemovals, findPrefixInMaster } from "./clientPrefix.js";
import {
  type DiffEngine,
  type DiffModel,
  type DiffSource,
  hashDiff,
  pickEntities,
  type SelectableEntity,
} from "./dataOps.js";
import { countImpact, type Impact } from "./impact.js";
import {
  type Dependency,
  type ExclusionResult,
  excludeItems,
  type ItemSelection,
  restrictToItems,
} from "./selection.js";

const entityLabels: Readonly<Record<SelectableEntity, Block["entity"]>> = {
  contentTypes: "Content type",
  contentTypeSnippets: "Snippet",
  taxonomies: "Taxonomy group",
  collections: "Collection",
  spaces: "Space",
  languages: "Language",
  workflows: "Workflow",
};

/** Synced items that need an excluded item block the sync. */
const withConflictBlocks = (
  analysis: Analysis,
  conflicts: ExclusionResult["conflicts"],
): Analysis => ({
  ...analysis,
  blocks: [
    ...analysis.blocks,
    ...conflicts.map((conflict) => ({
      entity: entityLabels[conflict.entity],
      owner: conflict.codename,
      reason: `${conflict.reason}. Remove the exclusion, or sync without this item.`,
    })),
  ],
});

export type DiffOptions = Readonly<{
  entities: ReadonlyArray<SelectableEntity>;
  /** A backup ID of the target: compare with the backup instead of the master (restore). */
  restoreFrom?: string | undefined;
  /** A master release ID: compare with that frozen version of the master instead of the live one. */
  release?: string | undefined;
  /** Restrict to these items per entity; entities not listed are compared whole. */
  items?: ItemSelection | undefined;
}>;

export type DestructiveChangeView = Readonly<{
  id: string;
  entity: string;
  owner: string;
  description: string;
  impact: Impact;
}>;

/** What the client is compared with: the master, or one of its own backups (restore). */
export type SourceView =
  | Readonly<{ kind: "master"; environmentId: string }>
  | Readonly<{ kind: "backup"; backupId: string; createdAt: string }>
  | Readonly<{ kind: "release"; releaseId: string; version: string; createdAt: string }>;

export type DiffResult = Readonly<{
  source: SourceView;
  target: Readonly<{
    environmentId: string;
    environmentName: string;
    projectId: string;
    projectName: string;
  }>;
  entities: ReadonlyArray<SelectableEntity>;
  generatedAt: string;
  /** Fingerprint of exactly what a sync would apply. Sent back when confirming a sync. */
  diffHash: string;
  /** True when there is nothing to sync for the chosen entities. */
  inSync: boolean;
  /** The item selection and the extra items it needed, or null when whole entities are compared. */
  selection: Readonly<{ items: ItemSelection; dependencies: ReadonlyArray<Dependency> }> | null;
  changes: ReadonlyArray<EntityChange>;
  destructive: ReadonlyArray<DestructiveChangeView>;
  blocks: ReadonlyArray<Block>;
  warnings: ReadonlyArray<Warning>;
  /** Client-only (prefixed) removals that were dropped from the diff. */
  keptClientItems: ReadonlyArray<string>;
  /** Items with changes that were left out because the client excludes them. */
  excludedItems: ExclusionResult["excluded"];
  /** The data-ops HTML report of the filtered diff. */
  reportHtml: string;
}>;

/** A computed diff with what a sync needs. Server-side only: it holds the target key. */
export type PreparedDiff = Readonly<{
  target: LocatedEnvironment;
  targetKey: string;
  source: SourceView;
  entities: ReadonlyArray<SelectableEntity>;
  /** Restricted to the chosen entities and filtered for client items: what sync applies. */
  model: DiffModel;
  diffHash: string;
  analysis: Analysis;
  keptClientItems: ReadonlyArray<string>;
  excludedItems: ExclusionResult["excluded"];
  selection: DiffResult["selection"];
}>;

export type DiffService = Readonly<{
  /** Compares the client with the master, or with one of its backups when restoreFrom is given. */
  diff: (targetEnvironmentId: string, options: DiffOptions) => Promise<DiffResult>;
  /** The diff pipeline without impact counts or report, used again just before a sync. */
  prepare: (targetEnvironmentId: string, options: DiffOptions) => Promise<PreparedDiff>;
}>;

export type DiffServiceDeps = Readonly<{
  config: Pick<AppConfig, "masterEnvironmentId" | "clientPrefix">;
  projects: Pick<ProjectService, "locate">;
  backups: Pick<BackupService, "get">;
  exclusions: Pick<ExclusionService, "get">;
  releases: Pick<ReleaseService, "get">;
  env: () => Readonly<Record<string, string | undefined>>;
  engine: DiffEngine;
  managementClient: (environmentId: string, apiKey: string) => ManagementClient;
  deliveryClient: (environmentId: string, apiKey: string | undefined) => DeliveryClient;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}>;

const defaultLog = (message: string, error: unknown) => {
  // Error name only: data-ops and HTTP library errors can carry request headers.
  console.error(message, error instanceof Error ? error.name : "unknown");
};

export const createDiffService = (deps: DiffServiceDeps): DiffService => {
  const log = deps.log ?? defaultLog;
  const prefix = deps.config.clientPrefix;

  const prepareInternal = async (targetEnvironmentId: string, options: DiffOptions) => {
    const { entities, restoreFrom, release, items } = options;
    if (restoreFrom !== undefined && release !== undefined) {
      throw new HttpError(
        400,
        "invalid_request",
        "Choose either a backup to restore or a release.",
      );
    }
    const env = deps.env();

    const target = await deps.projects.locate(targetEnvironmentId);
    if (target.isMasterProject) {
      throw new HttpError(
        403,
        "target_is_master",
        "Environments of the master project can never be a sync target.",
      );
    }

    const targetKey = resolveManagementKey(env, {
      environmentId: target.environmentId,
      projectId: target.projectId,
    });
    if (targetKey === null) {
      throw new HttpError(
        409,
        "key_missing",
        "No Management API key for the target environment. Use Test connection in the project overview.",
      );
    }

    // The desired model: the master environment, or a backup of this same environment.
    let source: DiffSource;
    let sourceView: SourceView;
    if (release !== undefined) {
      const frozen = await deps.releases.get(release);
      source = {
        kind: "snapshot",
        label: `release ${frozen.metadata.version}`,
        files: frozen.files,
      };
      sourceView = {
        kind: "release",
        releaseId: frozen.metadata.id,
        version: frozen.metadata.version,
        createdAt: frozen.metadata.createdAt,
      };
    } else if (restoreFrom === undefined) {
      const master = await deps.projects.locate(deps.config.masterEnvironmentId);
      const masterKey = resolveManagementKey(env, {
        environmentId: master.environmentId,
        projectId: master.projectId,
      });
      if (masterKey === null) {
        throw new HttpError(
          409,
          "key_missing",
          "No Management API key for the master environment. Use Test connection in the project overview.",
        );
      }
      source = {
        kind: "environment",
        environment: { environmentId: master.environmentId, apiKey: masterKey.value },
      };
      sourceView = { kind: "master", environmentId: master.environmentId };
    } else {
      // backups.get only returns a backup taken from this environment.
      const backup = await deps.backups.get(target.environmentId, restoreFrom);
      source = {
        kind: "snapshot",
        label: `backup ${backup.metadata.createdAt}`,
        files: backup.files,
      };
      sourceView = {
        kind: "backup",
        backupId: backup.metadata.id,
        createdAt: backup.metadata.createdAt,
      };
    }

    let rawModel: DiffModel;
    try {
      rawModel = await deps.engine.diff(
        source,
        { environmentId: target.environmentId, apiKey: targetKey.value },
        entities,
      );
    } catch (error) {
      log("data-ops diff failed", error);
      throw new HttpError(
        502,
        "diff_failed",
        "The diff could not be computed. Check the keys with Test connection, then try again.",
      );
    }

    const restricted =
      items === undefined
        ? { model: pickEntities(rawModel, entities), dependencies: [] }
        : restrictToItems(pickEntities(rawModel, entities), items);
    // Client exclusions apply to syncs from the master (live or a release). A restore puts
    // back exactly what the backup holds.
    const fromMaster = sourceView.kind !== "backup";
    const excluded = fromMaster
      ? excludeItems(restricted.model, (await deps.exclusions.get(target.projectId)).items)
      : { model: restricted.model, excluded: [], conflicts: [] };
    const picked = excluded.model;
    // A backup legitimately contains client items, so the master prefix rule only applies to the master.
    const masterPrefixHits = fromMaster ? findPrefixInMaster(picked, prefix) : [];
    const { model, dropped } = dropPrefixedRemovals(picked, prefix);

    const management = deps.managementClient(target.environmentId, targetKey.value);
    let targetModel: Parameters<typeof analyzeDiff>[1];
    let languages: Awaited<ReturnType<ManagementClient["listLanguages"]>>;
    try {
      const [types, snippets, taxonomies, langs] = await Promise.all([
        management.listTypes(),
        management.listSnippets(),
        management.listTaxonomies(),
        management.listLanguages(),
      ]);
      targetModel = { types, snippets, taxonomies };
      languages = langs;
    } catch (error) {
      log("Reading the target model failed", error);
      throw new HttpError(
        502,
        "target_model_failed",
        "The sub-project's content model could not be read. Check its key with Test connection.",
      );
    }

    const prepared: PreparedDiff = {
      target,
      targetKey: targetKey.value,
      source: sourceView,
      entities,
      model,
      diffHash: hashDiff(model, {
        sourceEnvironmentId:
          sourceView.kind === "master"
            ? sourceView.environmentId
            : sourceView.kind === "release"
              ? `release:${sourceView.releaseId}`
              : `backup:${sourceView.backupId}`,
        targetEnvironmentId: target.environmentId,
        entities,
        items,
      }),
      analysis: withConflictBlocks(
        analyzeDiff(model, targetModel, prefix, masterPrefixHits),
        excluded.conflicts,
      ),
      keptClientItems: dropped,
      excludedItems: excluded.excluded,
      selection: items === undefined ? null : { items, dependencies: restricted.dependencies },
    };
    return {
      prepared,
      management,
      targetModel,
      languages,
      sourceLabel: source.kind === "environment" ? source.environment.environmentId : source.label,
    };
  };

  return {
    prepare: async (targetEnvironmentId, options) =>
      (await prepareInternal(targetEnvironmentId, options)).prepared,

    diff: async (targetEnvironmentId, options) => {
      const { entities } = options;
      const { prepared, management, targetModel, languages, sourceLabel } = await prepareInternal(
        targetEnvironmentId,
        options,
      );
      const { target, analysis } = prepared;
      const impacts = await countImpact(analysis.destructive, {
        management,
        delivery: deps.deliveryClient(
          target.environmentId,
          resolveDeliveryKey(deps.env(), target.environmentId) ?? undefined,
        ),
        types: targetModel.types,
        languages,
      });

      return {
        source: prepared.source,
        target: {
          environmentId: target.environmentId,
          environmentName: target.environmentName,
          projectId: target.projectId,
          projectName: target.projectName,
        },
        entities,
        generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
        diffHash: prepared.diffHash,
        inSync: analysis.changes.length === 0,
        selection: prepared.selection,
        changes: analysis.changes,
        destructive: analysis.destructive.map((change) => ({
          id: change.id,
          entity: change.entity,
          owner: change.owner,
          description: change.description,
          impact: impacts.get(change.id) ?? {
            latest: null,
            published: null,
            unknownReasons: ["Not counted."],
          },
        })),
        blocks: analysis.blocks,
        warnings: analysis.warnings,
        keptClientItems: prepared.keptClientItems,
        excludedItems: prepared.excludedItems,
        reportHtml: deps.engine.renderReport(
          prepared.model,
          {
            source: sourceLabel,
            sourceIsEnvironment: prepared.source.kind === "master",
            targetEnvironmentId: target.environmentId,
          },
          entities,
        ),
      };
    },
  };
};
