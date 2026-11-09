import { z } from "zod";
import type { Caller } from "../access/accessGuard.js";
import type { AuditLog } from "../audit/auditLog.js";
import { HttpError } from "../errors.js";
import type { ProjectService } from "../projects/projectService.js";
import type { KvStore } from "../storage/kvStore.js";
import { selectableEntities } from "../sync/dataOps.js";
import { type Exclusions, itemsSchema } from "../sync/selection.js";

const storedSchema = z.object({
  items: itemsSchema,
  updatedAt: z.string(),
  updatedBy: z.object({ userId: z.string(), email: z.string() }),
});

export type ClientExclusions = Readonly<{
  projectId: string;
  items: Exclusions;
  updatedAt: string | null;
  updatedBy: Readonly<{ userId: string; email: string }> | null;
}>;

export type ExclusionService = Readonly<{
  get: (projectId: string) => Promise<ClientExclusions>;
  /** Replaces the client's exclusions. Audited. */
  set: (caller: Caller, projectId: string, items: Exclusions) => Promise<ClientExclusions>;
}>;

export type ExclusionServiceDeps = Readonly<{
  projects: Pick<ProjectService, "overview">;
  kv: KvStore;
  audit: AuditLog;
  now?: () => Date;
}>;

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyFor = (projectId: string) => `exclusions/${projectId}`;

/** Sorted, de-duplicated, without empty entries, so equal exclusions are stored identically. */
const normalise = (items: Exclusions): Exclusions =>
  Object.fromEntries(
    selectableEntities.flatMap((entity) => {
      const codenames = [...new Set(items[entity] ?? [])].sort();
      return codenames.length === 0 ? [] : [[entity, codenames]];
    }),
  );

export const createExclusionService = (deps: ExclusionServiceDeps): ExclusionService => {
  const now = deps.now ?? (() => new Date());

  const validProjectId = (raw: string) => {
    const projectId = raw.trim().toLowerCase();
    if (!guid.test(projectId)) {
      throw new HttpError(400, "invalid_request", "Project ID must be a GUID");
    }
    return projectId;
  };

  const read = async (projectId: string): Promise<ClientExclusions> => {
    const parsed = storedSchema.safeParse(await deps.kv.getJson(keyFor(projectId)));
    return parsed.success
      ? { projectId, ...parsed.data, items: normalise(parsed.data.items) }
      : { projectId, items: {}, updatedAt: null, updatedBy: null };
  };

  return {
    get: async (rawProjectId) => await read(validProjectId(rawProjectId)),

    set: async (caller, rawProjectId, rawItems) => {
      const projectId = validProjectId(rawProjectId);
      const project = (await deps.projects.overview()).projects.find(
        (p) => p.id.toLowerCase() === projectId,
      );
      if (project === undefined) {
        throw new HttpError(404, "unknown_project", "This project is not in the subscription");
      }
      if (project.isMasterProject) {
        throw new HttpError(
          403,
          "target_is_master",
          "Exclusions are for sub-projects. The master is never synced.",
        );
      }

      const items = normalise(rawItems);
      const event = await deps.audit.begin({
        actor: { userId: caller.userId, email: caller.email },
        action: "exclusions.update",
        target: projectId,
      });
      const stored = {
        items,
        updatedAt: now().toISOString(),
        updatedBy: { userId: caller.userId, email: caller.email },
      };
      try {
        await deps.kv.setJson(keyFor(projectId), stored);
      } catch (error) {
        await deps.audit.complete(event, "failed", {
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
      await deps.audit.complete(event, "succeeded", {
        excluded: Object.values(items).reduce((sum, list) => sum + (list?.length ?? 0), 0),
        items: Object.entries(items)
          .map(([entity, list]) => `${entity}:${(list ?? []).join("|")}`)
          .join(",")
          .slice(0, 1000),
      });
      return { projectId, ...stored };
    },
  };
};
