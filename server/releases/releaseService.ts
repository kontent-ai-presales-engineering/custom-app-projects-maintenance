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
  version: z.string(),
  notes: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ userId: z.string(), email: z.string() }),
  counts: z.record(z.string(), z.number()),
});

export type ReleaseMetadata = z.infer<typeof metadataSchema>;

const releaseSchema = z.object({
  metadata: metadataSchema,
  files: z.record(z.string(), z.unknown()),
});

export type Release = Readonly<{ metadata: ReleaseMetadata; files: SnapshotFiles }>;

const clientReleaseSchema = z.object({
  releaseId: z.string().nullable(),
  version: z.string().nullable(),
  syncedAt: z.string(),
  syncedBy: z.object({ userId: z.string(), email: z.string() }),
});

/** What a client environment was last synced from: a release, or the live master (null). */
export type ClientRelease = z.infer<typeof clientReleaseSchema>;

export type ReleaseService = Readonly<{
  /** Snapshots the master's content model as a new version. Audited. */
  create: (caller: Caller, version: string, notes: string) => Promise<ReleaseMetadata>;
  /** Most recent first. */
  list: () => Promise<ReadonlyArray<ReleaseMetadata>>;
  get: (releaseId: string) => Promise<Release>;
  /** Records what a client environment was synced from. Called after a successful sync. */
  recordClientRelease: (
    caller: Caller,
    environmentId: string,
    release: Readonly<{ releaseId: string; version: string }> | null,
  ) => Promise<void>;
  clientReleases: () => Promise<Readonly<Record<string, ClientRelease>>>;
}>;

export type ReleaseServiceDeps = Readonly<{
  config: Pick<AppConfig, "masterEnvironmentId">;
  projects: Pick<ProjectService, "locate">;
  env: () => Readonly<Record<string, string | undefined>>;
  snapshotter: Snapshotter;
  kv: KvStore;
  audit: AuditLog;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}>;

/** Versions such as v1, v2.1 or 2026-11-release: letters, digits, dot, dash, underscore. */
export const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const releaseIdPattern = /^[0-9]{15}-[0-9a-f]{8}$/;
const maxNotesLength = 5000;

const dataKey = (id: string) => `releases/${id}`;
const indexPrefix = "release-index/";
const clientPrefix = "client-release/";

export class ReleaseNotFoundError extends HttpError {
  override readonly name = "ReleaseNotFoundError";

  constructor() {
    super(404, "release_not_found", "Release not found");
  }
}

const countEntries = (files: SnapshotFiles) =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name !== "metadata.json")
      .map(([name, content]) => [name, Array.isArray(content) ? content.length : 1]),
  );

const defaultLog = (message: string, error: unknown) => {
  console.error(message, error instanceof Error ? error.name : "unknown");
};

export const createReleaseService = (deps: ReleaseServiceDeps): ReleaseService => {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  const list = async () => {
    const keys = (await deps.kv.listKeys(indexPrefix)).toReversed();
    const entries = await Promise.all(keys.map(async (key) => await deps.kv.getJson(key)));
    return entries.flatMap((entry) => {
      const parsed = metadataSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  };

  return {
    list,

    create: async (caller, rawVersion, rawNotes) => {
      const version = rawVersion.trim();
      const notes = rawNotes.trim();
      if (!versionPattern.test(version)) {
        throw new HttpError(
          400,
          "invalid_version",
          "Use a short version label with letters, digits, dots, dashes or underscores, for example v3.",
        );
      }
      if (notes.length > maxNotesLength) {
        throw new HttpError(
          400,
          "invalid_request",
          `Notes can be at most ${maxNotesLength} characters.`,
        );
      }
      if (
        (await list()).some((release) => release.version.toLowerCase() === version.toLowerCase())
      ) {
        throw new HttpError(409, "version_exists", `Version ${version} already exists.`);
      }

      const master = await deps.projects.locate(deps.config.masterEnvironmentId);
      const key = resolveManagementKey(deps.env(), {
        environmentId: master.environmentId,
        projectId: master.projectId,
      });
      if (key === null) {
        throw new HttpError(
          409,
          "key_missing",
          "No Management API key for the master environment.",
        );
      }

      const event = await deps.audit.begin({
        actor: { userId: caller.userId, email: caller.email },
        action: "release.create",
        target: master.environmentId,
      });
      try {
        const files = await deps.snapshotter.snapshot({
          environmentId: master.environmentId,
          apiKey: key.value,
        });
        const createdAt = now();
        const metadata: ReleaseMetadata = {
          id: `${String(createdAt.getTime()).padStart(15, "0")}-${randomUUID().slice(0, 8)}`,
          version,
          notes,
          createdAt: createdAt.toISOString(),
          createdBy: { userId: caller.userId, email: caller.email },
          counts: countEntries(files),
        };
        await deps.kv.setJson(dataKey(metadata.id), { metadata, files });
        await deps.kv.setJson(`${indexPrefix}${metadata.id}`, metadata);
        await deps.audit.complete(event, "succeeded", { version, releaseId: metadata.id });
        return metadata;
      } catch (error) {
        log("Release snapshot failed", error);
        await deps.audit.complete(event, "failed", {
          version,
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw new HttpError(
          502,
          "release_failed",
          "The master's content model could not be read. Check its key with Test connection.",
        );
      }
    },

    get: async (releaseId) => {
      if (!releaseIdPattern.test(releaseId)) {
        throw new ReleaseNotFoundError();
      }
      const parsed = releaseSchema.safeParse(await deps.kv.getJson(dataKey(releaseId)));
      if (!parsed.success) {
        throw new ReleaseNotFoundError();
      }
      return parsed.data;
    },

    recordClientRelease: async (caller, environmentId, release) => {
      await deps.kv.setJson(`${clientPrefix}${environmentId}`, {
        releaseId: release?.releaseId ?? null,
        version: release?.version ?? null,
        syncedAt: now().toISOString(),
        syncedBy: { userId: caller.userId, email: caller.email },
      } satisfies ClientRelease);
    },

    clientReleases: async () => {
      const keys = await deps.kv.listKeys(clientPrefix);
      const entries = await Promise.all(
        keys.map(
          async (key) => [key.slice(clientPrefix.length), await deps.kv.getJson(key)] as const,
        ),
      );
      return Object.fromEntries(
        entries.flatMap(([environmentId, raw]) => {
          const parsed = clientReleaseSchema.safeParse(raw);
          return parsed.success ? [[environmentId, parsed.data]] : [];
        }),
      );
    },
  };
};
