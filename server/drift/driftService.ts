import { z } from "zod";
import type { Caller } from "../access/accessGuard.js";
import { HttpError } from "../errors.js";
import type { KvStore } from "../storage/kvStore.js";
import { defaultEntities } from "../sync/dataOps.js";
import type { DiffService } from "../sync/diffService.js";

const summarySchema = z.object({
  environmentId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  environmentName: z.string(),
  checkedAt: z.string(),
  checkedBy: z.object({ userId: z.string(), email: z.string() }),
  entities: z.array(z.string()),
  status: z.enum(["in_sync", "drift", "blocked", "error"]),
  changes: z.number(),
  destructive: z.number(),
  blocks: z.number(),
  excluded: z.number(),
  /** Set when status is "error": a message safe to show. */
  error: z.string().nullable(),
});

/** The latest drift check of one client environment. */
export type DriftSummary = z.infer<typeof summarySchema>;

export type DriftService = Readonly<{
  /** Compares the environment with the master now and stores the summary. Read-only in Kontent.ai. */
  check: (caller: Caller, environmentId: string) => Promise<DriftSummary>;
  /** The latest stored summary per environment. */
  list: () => Promise<ReadonlyArray<DriftSummary>>;
}>;

export type DriftServiceDeps = Readonly<{
  diff: Pick<DiffService, "prepare">;
  kv: KvStore;
  now?: () => Date;
}>;

const prefix = "drift/";
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const createDriftService = (deps: DriftServiceDeps): DriftService => {
  const now = deps.now ?? (() => new Date());

  return {
    check: async (caller, rawEnvironmentId) => {
      const environmentId = rawEnvironmentId.trim().toLowerCase();
      if (!guid.test(environmentId)) {
        throw new HttpError(400, "invalid_request", "Environment ID must be a GUID");
      }
      const base = {
        environmentId,
        checkedAt: now().toISOString(),
        checkedBy: { userId: caller.userId, email: caller.email },
        entities: [...defaultEntities],
      };

      let summary: DriftSummary;
      try {
        const prepared = await deps.diff.prepare(environmentId, { entities: defaultEntities });
        const { analysis } = prepared;
        summary = {
          ...base,
          projectId: prepared.target.projectId,
          projectName: prepared.target.projectName,
          environmentName: prepared.target.environmentName,
          status:
            analysis.blocks.length > 0
              ? "blocked"
              : analysis.changes.length > 0
                ? "drift"
                : "in_sync",
          changes: analysis.changes.length,
          destructive: analysis.destructive.length,
          blocks: analysis.blocks.length,
          excluded: prepared.excludedItems.length,
          error: null,
        };
      } catch (error) {
        // Unknown environments and the master are refused outright, not stored.
        if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
          throw error;
        }
        const existing = summarySchema.safeParse(
          await deps.kv.getJson(`${prefix}${environmentId}`),
        );
        summary = {
          ...base,
          projectId: existing.success ? existing.data.projectId : "",
          projectName: existing.success ? existing.data.projectName : "",
          environmentName: existing.success ? existing.data.environmentName : "",
          status: "error",
          changes: 0,
          destructive: 0,
          blocks: 0,
          excluded: 0,
          error:
            error instanceof HttpError
              ? error.message
              : "The check failed. Use Test connection, then try again.",
        };
      }

      await deps.kv.setJson(`${prefix}${environmentId}`, summary);
      return summary;
    },

    list: async () => {
      const keys = await deps.kv.listKeys(prefix);
      const entries = await Promise.all(keys.map(async (key) => await deps.kv.getJson(key)));
      return entries.flatMap((entry) => {
        const parsed = summarySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    },
  };
};
