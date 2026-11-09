import type { ManagementClient } from "../kontent/managementClient.js";
import type { SelectableEntity } from "../sync/dataOps.js";
import type { DiffService } from "../sync/diffService.js";

/** One environment in a rollout plan: what a sync would do there, and its stage. */
export type RolloutPlanEntry = Readonly<{
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  /** null when it could not be determined; such environments go in the production stage. */
  isProduction: boolean | null;
  stage: "non-production" | "production";
  diffHash: string;
  status: "ready" | "in_sync" | "blocked";
  changes: number;
  destructive: number;
  excluded: number;
  blocks: ReadonlyArray<string>;
}>;

export type RolloutService = Readonly<{
  plan: (
    environmentId: string,
    entities: ReadonlyArray<SelectableEntity>,
    release?: string | undefined,
  ) => Promise<RolloutPlanEntry>;
}>;

export type RolloutServiceDeps = Readonly<{
  diff: Pick<DiffService, "prepare">;
  managementClient: (
    environmentId: string,
    apiKey: string,
  ) => Pick<ManagementClient, "getEnvironmentInfo">;
}>;

/**
 * Plans one environment of a rollout. The rollout itself is a series of ordinary syncs,
 * each with its own fingerprint check, backup, validation and audit entry.
 */
export const createRolloutService = (deps: RolloutServiceDeps): RolloutService => ({
  plan: async (environmentId, entities, release) => {
    const prepared = await deps.diff.prepare(environmentId, { entities, release });
    const { target, analysis } = prepared;

    // Unknown counts as production, so it never runs before the non-production stage.
    const isProduction = await deps
      .managementClient(target.environmentId, prepared.targetKey)
      .getEnvironmentInfo()
      .then((info) => info.is_production ?? null)
      .catch(() => null);

    return {
      environmentId: target.environmentId,
      environmentName: target.environmentName,
      projectId: target.projectId,
      projectName: target.projectName,
      isProduction,
      stage: isProduction === false ? "non-production" : "production",
      diffHash: prepared.diffHash,
      status:
        analysis.blocks.length > 0
          ? "blocked"
          : analysis.changes.length === 0
            ? "in_sync"
            : "ready",
      changes: analysis.changes.length,
      destructive: analysis.destructive.length,
      excluded: prepared.excludedItems.length,
      blocks: analysis.blocks.map((block) => `${block.entity} ${block.owner}: ${block.reason}`),
    };
  },
});
