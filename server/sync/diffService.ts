import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { resolveDeliveryKey, resolveManagementKey } from "../keys/envKeys.js";
import type { DeliveryClient } from "../kontent/deliveryClient.js";
import type { ManagementClient } from "../kontent/managementClient.js";
import type { ProjectService } from "../projects/projectService.js";
import { analyzeDiff, type Block, type EntityChange, type Warning } from "./analyze.js";
import { dropPrefixedRemovals, findPrefixInMaster } from "./clientPrefix.js";
import type { DiffEngine, SelectableEntity } from "./dataOps.js";
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

export type DiffService = Readonly<{
  diff: (
    targetEnvironmentId: string,
    entities: ReadonlyArray<SelectableEntity>,
  ) => Promise<DiffResult>;
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

export const createDiffService = (deps: DiffServiceDeps): DiffService => ({
  diff: async (targetEnvironmentId, entities) => {
    const log = deps.log ?? defaultLog;
    const prefix = deps.config.clientPrefix;
    const masterId = deps.config.masterEnvironmentId;
    const env = deps.env();

    const target = await deps.projects.locate(targetEnvironmentId);
    if (target.isMasterProject) {
      throw new HttpError(
        403,
        "target_is_master",
        "Environments of the master project can never be a sync target.",
      );
    }

    const master = await deps.projects.locate(masterId);
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

    let rawModel: Awaited<ReturnType<DiffEngine["diff"]>>;
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

    const masterPrefixHits = findPrefixInMaster(rawModel, prefix);
    const { model, dropped } = dropPrefixedRemovals(rawModel, prefix);

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

    const analysis = analyzeDiff(model, targetModel, prefix, masterPrefixHits);
    const impacts = await countImpact(analysis.destructive, {
      management,
      delivery: deps.deliveryClient(
        target.environmentId,
        resolveDeliveryKey(env, target.environmentId) ?? undefined,
      ),
      types: targetModel.types,
      languages,
    });

    return {
      source: { environmentId: master.environmentId },
      target: {
        environmentId: target.environmentId,
        environmentName: target.environmentName,
        projectId: target.projectId,
        projectName: target.projectName,
      },
      entities,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
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
      keptClientItems: dropped,
      reportHtml: deps.engine.renderReport(
        model,
        { sourceEnvironmentId: master.environmentId, targetEnvironmentId: target.environmentId },
        entities,
      ),
    };
  },
});
