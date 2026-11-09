import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Caller } from "../access/accessGuard.js";
import type { AuditLog } from "../audit/auditLog.js";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { resolveManagementKey } from "../keys/envKeys.js";
import type { ProjectService } from "../projects/projectService.js";
import type { KvStore } from "../storage/kvStore.js";
import type { SnapshotFiles, Snapshotter } from "../sync/dataOps.js";

const metadataSchema = z.object({
  id: z.string(),
  environmentId: z.string(),
  environmentName: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ userId: z.string(), email: z.string() }),
  reason: z.enum(["manual", "pre-sync", "pre-restore"]),
  /** Number of entries per snapshot file, for example { "contentTypes.json": 12 }. */
  counts: z.record(z.string(), z.number()),
});

export type BackupMetadata = z.infer<typeof metadataSchema>;

const backupSchema = z.object({
  metadata: metadataSchema,
  files: z.record(z.string(), z.unknown()),
});

export type Backup = Readonly<{ metadata: BackupMetadata; files: SnapshotFiles }>;

export type BackupService = Readonly<{
  /** Snapshots the environment's content model and stores it. Audited. */
  create: (
    caller: Caller,
    environmentId: string,
    reason: BackupMetadata["reason"],
  ) => Promise<BackupMetadata>;
  /** Most recent first. */
  list: (environmentId: string) => Promise<ReadonlyArray<BackupMetadata>>;
  get: (environmentId: string, backupId: string) => Promise<Backup>;
}>;

export type BackupServiceDeps = Readonly<{
  config: Pick<AppConfig, "masterEnvironmentId">;
  projects: Pick<ProjectService, "locate">;
  env: () => Readonly<Record<string, string | undefined>>;
  snapshotter: Snapshotter;
  kv: KvStore;
  audit: AuditLog;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}>;

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const backupIdPattern = /^\d{15}-[0-9a-f]{8}$/;

const dataKey = (environmentId: string, id: string) => `backups/${environmentId}/${id}`;
const indexPrefix = (environmentId: string) => `backup-index/${environmentId}/`;

const countEntries = (files: SnapshotFiles) =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name !== "metadata.json")
      .map(([name, content]) => [name, Array.isArray(content) ? content.length : 1]),
  );

const defaultLog = (message: string, error: unknown) => {
  // Error name only: data-ops errors can contain serialised request details.
  console.error(message, error instanceof Error ? error.name : "unknown");
};

export class BackupNotFoundError extends HttpError {
  override readonly name = "BackupNotFoundError";

  constructor() {
    super(404, "backup_not_found", "Backup not found");
  }
}

export const createBackupService = (deps: BackupServiceDeps): BackupService => {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  const normalise = (environmentId: string) => {
    const id = environmentId.trim().toLowerCase();
    if (!guid.test(id)) {
      throw new HttpError(400, "invalid_request", "Environment ID must be a GUID");
    }
    return id;
  };

  return {
    create: async (caller, rawEnvironmentId, reason) => {
      const target = await deps.projects.locate(normalise(rawEnvironmentId));
      if (target.isMasterProject) {
        throw new HttpError(
          403,
          "target_is_master",
          "Backups are made of sub-project environments only. The master is never changed by this app.",
        );
      }
      const key = resolveManagementKey(deps.env(), {
        environmentId: target.environmentId,
        projectId: target.projectId,
      });
      if (key === null) {
        throw new HttpError(409, "key_missing", "No Management API key for this environment.");
      }

      // Written first: if the audit entry cannot be stored, no backup is attempted.
      const event = await deps.audit.begin({
        actor: { userId: caller.userId, email: caller.email },
        action: "backup.create",
        target: target.environmentId,
      });

      try {
        const files = await deps.snapshotter.snapshot({
          environmentId: target.environmentId,
          apiKey: key.value,
        });
        const createdAt = now();
        const metadata: BackupMetadata = {
          id: `${String(createdAt.getTime()).padStart(15, "0")}-${randomUUID().slice(0, 8)}`,
          environmentId: target.environmentId,
          environmentName: target.environmentName,
          projectId: target.projectId,
          projectName: target.projectName,
          createdAt: createdAt.toISOString(),
          createdBy: { userId: caller.userId, email: caller.email },
          reason,
          counts: countEntries(files),
        };
        // Data first, index second: an index entry always points at stored data.
        await deps.kv.setJson(dataKey(target.environmentId, metadata.id), { metadata, files });
        await deps.kv.setJson(`${indexPrefix(target.environmentId)}${metadata.id}`, metadata);
        await deps.audit.complete(event, "succeeded", { backupId: metadata.id, reason });
        return metadata;
      } catch (error) {
        log("Backup failed", error);
        await deps.audit.complete(event, "failed", {
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw new HttpError(
          502,
          "backup_failed",
          "The backup could not be made. Check the key with Test connection, then try again.",
        );
      }
    },

    list: async (rawEnvironmentId) => {
      const environmentId = normalise(rawEnvironmentId);
      const keys = (await deps.kv.listKeys(indexPrefix(environmentId))).toReversed();
      const entries = await Promise.all(keys.map(async (key) => await deps.kv.getJson(key)));
      return entries.flatMap((entry) => {
        const parsed = metadataSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    },

    get: async (rawEnvironmentId, backupId) => {
      const environmentId = normalise(rawEnvironmentId);
      if (!backupIdPattern.test(backupId)) {
        throw new BackupNotFoundError();
      }
      const parsed = backupSchema.safeParse(
        await deps.kv.getJson(dataKey(environmentId, backupId)),
      );
      if (!parsed.success || parsed.data.metadata.environmentId !== environmentId) {
        throw new BackupNotFoundError();
      }
      return parsed.data;
    },
  };
};
