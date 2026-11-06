import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { resolveDeliveryKey, resolveManagementKey } from "../keys/envKeys.js";
import type { DeliveryClient } from "../kontent/deliveryClient.js";
import type { ManagementClient } from "../kontent/managementClient.js";
import type { LocatedEnvironment, ProjectService } from "../projects/projectService.js";
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
  hashDiff,
  pickEntities,
  type SelectableEntity,
} from "./dataOps.js";
import { countImpact, type Impact } from "./impact.js";

export type DestructiveChangeView = Readonly<{
  id: string;
  entity: string;
  owner: string;
  description: string;
  impact: Impact;
}>;

export type DiffResult = Readonly<{
  source: Readonly<{ environmentId: string }>;
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
  changes: ReadonlyArray<EntityChange>;
  destructive: ReadonlyArray<DestructiveChangeView>;
  blocks: ReadonlyArray<Block>;
  warnings: ReadonlyArray<Warning>;
  /** Client-only (prefixed) removals that were dropped from the diff. */
  keptClientItems: ReadonlyArray<string>;
  /** The data-ops HTML report of the filtered diff. */
  reportHtml: string;
}>;

/** A computed diff with what a sync needs. Server-side only: it holds the target key. */
export type PreparedDiff = Readonly<{
  target: LocatedEnvironment;
  targetKey: string;
  masterEnvironmentId: string;
  entities: ReadonlyArray<SelectableEntity>;
  /** Restricted to the chosen entities and filtered for client items: what sync applies. */
  model: DiffModel;
  diffHash: string;
  analysis: Analysis;
  keptClientItems: ReadonlyArray<string>;
}>;

export type DiffService = Readonly<{
  diff: (
    targetEnvironmentId: string,
    entities: ReadonlyArray<SelectableEntity>,
  ) => Promise<DiffResult>;
  /** The diff pipeline without impact counts or report, used again just before a sync. */
  prepare: (
    targetEnvironmentId: string,
    entities: ReadonlyArray<SelectableEntity>,
  ) => Promise<PreparedDiff>;
}>;

export type DiffServiceDeps = Readonly<{
  config: Pick<AppConfig, "masterEnvironmentId" | "clientPrefix">;
  projects: Pick<ProjectService, "locate">;
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

  const prepareInternal = async (
    targetEnvironmentId: string,
    entities: ReadonlyArray<SelectableEntity>,
  ) => {
    const env = deps.env();

    const target = await deps.projects.locate(targetEnvironmentId);
    if (target.isMasterProject) {
      throw new HttpError(
        403,
        "target_is_master",
        "Environments of the master project can never be a sync target.",
      );
    }

    const master = await deps.projects.locate(deps.config.masterEnvironmentId);
    const masterKey = resolveManagementKey(env, {
      environmentId: master.environmentId,
      projectId: master.projectId,
    });
    const targetKey = resolveManagementKey(env, {
      environmentId: target.environmentId,
      projectId: target.projectId,
    });
    if (masterKey === null || targetKey === null) {
      throw new HttpError(
        409,
        "key_missing",
        `No Management API key for the ${masterKey === null ? "master" : "target"} environment. Use Test connection in the project overview.`,
      );
    }

    let rawModel: DiffModel;
    try {
      rawModel = await deps.engine.diff(
        { environmentId: master.environmentId, apiKey: masterKey.value },
        { environmentId: target.environmentId, apiKey: targetKey.value },
        entities,
      );
    } catch (error) {
      log("data-ops diff failed", error);
      throw new HttpError(
        502,
        "diff_failed",
        "The diff could not be computed. Check both keys with Test connection, then try again.",
      );
    }

    const picked = pickEntities(rawModel, entities);
    const masterPrefixHits = findPrefixInMaster(picked, prefix);
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
        "The client's content model could not be read. Check its key with Test connection.",
      );
    }

    const prepared: PreparedDiff = {
      target,
      targetKey: targetKey.value,
      masterEnvironmentId: master.environmentId,
      entities,
      model,
      diffHash: hashDiff(model, {
        sourceEnvironmentId: master.environmentId,
        targetEnvironmentId: target.environmentId,
        entities,
      }),
      analysis: analyzeDiff(model, targetModel, prefix, masterPrefixHits),
      keptClientItems: dropped,
    };
    return { prepared, management, targetModel, languages };
  };

  return {
    prepare: async (targetEnvironmentId, entities) =>
      (await prepareInternal(targetEnvironmentId, entities)).prepared,

    diff: async (targetEnvironmentId, entities) => {
      const { prepared, management, targetModel, languages } = await prepareInternal(
        targetEnvironmentId,
        entities,
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
        source: { environmentId: prepared.masterEnvironmentId },
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
        reportHtml: deps.engine.renderReport(
          prepared.model,
          {
            sourceEnvironmentId: prepared.masterEnvironmentId,
            targetEnvironmentId: target.environmentId,
          },
          entities,
        ),
      };
    },
  };
};
