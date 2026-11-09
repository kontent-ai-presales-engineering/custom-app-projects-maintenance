import { z } from "zod";
import type { Caller } from "../access/accessGuard.js";
import { HttpError } from "../errors.js";
import { resolveManagementKey } from "../keys/envKeys.js";
import type { ManagementClient } from "../kontent/managementClient.js";
import type { SubscriptionClient } from "../kontent/subscriptionClient.js";
import type { ProjectService } from "../projects/projectService.js";
import type { KvStore } from "../storage/kvStore.js";

const environmentMetricsSchema = z.object({
  environmentId: z.string(),
  contentItems: z.number().nullable(),
  contentTypes: z.number().nullable(),
  countedAt: z.string(),
  countedBy: z.object({ userId: z.string(), email: z.string() }),
  /** A message safe to show when counting failed. */
  error: z.string().nullable(),
});

/** Counts for one environment, stored until refreshed. */
export type EnvironmentMetrics = z.infer<typeof environmentMetricsSchema>;

/** Users assigned to a project (in any of its environments). */
export type ProjectUsers = Readonly<{ total: number; active: number }>;

export type MetricsOverview = Readonly<{
  environments: Readonly<Record<string, EnvironmentMetrics>>;
  projects: Readonly<Record<string, ProjectUsers>>;
  /** Set when the user counts could not be read; environment counts are still returned. */
  usersError: string | null;
}>;

export type MetricsService = Readonly<{
  overview: () => Promise<MetricsOverview>;
  /** Counts content items and content types of one environment now and stores the result. */
  refresh: (caller: Caller, environmentId: string) => Promise<EnvironmentMetrics>;
}>;

export type MetricsServiceDeps = Readonly<{
  projects: Pick<ProjectService, "locate">;
  subscription: Pick<SubscriptionClient, "listUsers">;
  env: () => Readonly<Record<string, string | undefined>>;
  managementClient: (
    environmentId: string,
    apiKey: string,
  ) => Pick<ManagementClient, "countItems" | "listTypes">;
  kv: KvStore;
  now?: () => number;
}>;

const prefix = "metrics/";
const usersCacheMs = 5 * 60 * 1000;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const createMetricsService = (deps: MetricsServiceDeps): MetricsService => {
  const now = deps.now ?? Date.now;
  let usersCache: { expires: number; value: Promise<Record<string, ProjectUsers>> } | undefined;

  /** Users per project, from one paginated Subscription API listing, cached for 5 minutes. */
  const usersPerProject = async () => {
    if (usersCache === undefined || usersCache.expires <= now()) {
      const value = deps.subscription.listUsers().then((users) => {
        const counts: Record<string, { total: number; active: number }> = {};
        for (const user of users) {
          for (const project of user.projects) {
            const projectId = project.id.toLowerCase();
            const entry = counts[projectId] ?? { total: 0, active: 0 };
            counts[projectId] = entry;
            entry.total += 1;
            if (project.environments.some((environment) => environment.is_user_active)) {
              entry.active += 1;
            }
          }
        }
        return counts;
      });
      usersCache = { expires: now() + usersCacheMs, value };
      value.catch(() => {
        usersCache = undefined;
      });
    }
    return await usersCache.value;
  };

  return {
    overview: async () => {
      const keys = await deps.kv.listKeys(prefix);
      const stored = await Promise.all(keys.map(async (key) => await deps.kv.getJson(key)));
      const environments = Object.fromEntries(
        stored.flatMap((raw) => {
          const parsed = environmentMetricsSchema.safeParse(raw);
          return parsed.success ? [[parsed.data.environmentId, parsed.data]] : [];
        }),
      );
      try {
        return { environments, projects: await usersPerProject(), usersError: null };
      } catch {
        return {
          environments,
          projects: {},
          usersError: "User counts could not be read from the Subscription API.",
        };
      }
    },

    refresh: async (caller, rawEnvironmentId) => {
      const environmentId = rawEnvironmentId.trim().toLowerCase();
      if (!guid.test(environmentId)) {
        throw new HttpError(400, "invalid_request", "Environment ID must be a GUID");
      }
      const located = await deps.projects.locate(environmentId);
      const key = resolveManagementKey(deps.env(), {
        environmentId: located.environmentId,
        projectId: located.projectId,
      });
      if (key === null) {
        throw new HttpError(409, "key_missing", "No Management API key for this environment.");
      }

      const client = deps.managementClient(located.environmentId, key.value);
      const base = {
        environmentId: located.environmentId,
        countedAt: new Date(now()).toISOString(),
        countedBy: { userId: caller.userId, email: caller.email },
      };
      const [items, types] = await Promise.allSettled([client.countItems(), client.listTypes()]);
      const metrics: EnvironmentMetrics = {
        ...base,
        contentItems: items.status === "fulfilled" ? items.value : null,
        contentTypes: types.status === "fulfilled" ? types.value.length : null,
        error:
          items.status === "rejected" || types.status === "rejected"
            ? "Some counts could not be read. Check the key with Test connection (it needs Read content)."
            : null,
      };
      await deps.kv.setJson(`${prefix}${located.environmentId}`, metrics);
      return metrics;
    },
  };
};
