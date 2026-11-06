import type { Caller } from "../access/accessGuard.js";
import type { AuditLog } from "../audit/auditLog.js";
import type { BackupService } from "../backup/backupService.js";
import { HttpError } from "../errors.js";
import type { KvStore } from "../storage/kvStore.js";
import type { SelectableEntity, SyncEngine } from "./dataOps.js";
import type { DiffService } from "./diffService.js";

export type SyncRequest = Readonly<{
  environmentId: string;
  entities: ReadonlyArray<SelectableEntity>;
  /** The diffHash of the diff the user confirmed. */
  diffHash: string;
  /** Must equal the target project name. */
  confirmProjectName: string;
  /** Must be true when the diff contains destructive changes. */
  confirmDestructive: boolean;
}>;

export type SyncOutcome =
  | Readonly<{
      status: "succeeded";
      backupId: string;
      operations: number;
      projectName: string;
      environmentName: string;
    }>
  | Readonly<{ status: "nothing_to_sync" }>
  | Readonly<{ status: "validation_failed"; backupId: string; problems: ReadonlyArray<string> }>;

export type SyncService = Readonly<{
  sync: (caller: Caller, request: SyncRequest) => Promise<SyncOutcome>;
}>;

export type SyncServiceDeps = Readonly<{
  diff: Pick<DiffService, "prepare">;
  backups: Pick<BackupService, "create">;
  engine: SyncEngine;
  kv: KvStore;
  audit: AuditLog;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}>;

/** A lock older than this is considered abandoned (for example a function that timed out). */
const lockTtlMs = 15 * 60 * 1000;

const defaultLog = (message: string, error: unknown) => {
  console.error(message, error instanceof Error ? error.name : "unknown");
};

const countOperations = (prepared: Awaited<ReturnType<DiffService["prepare"]>>) =>
  prepared.analysis.changes.reduce((sum, change) => sum + Math.max(change.operations.length, 1), 0);

export const createSyncService = (deps: SyncServiceDeps): SyncService => {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  const lockKey = (environmentId: string) => `locks/sync/${environmentId}`;

  /** One sync per environment at a time. Stale locks (older than the TTL) are taken over. */
  const acquireLock = async (environmentId: string, caller: Caller) => {
    const lock = { holder: caller.email, acquiredAt: now().toISOString() };
    if (await deps.kv.createIfAbsent(lockKey(environmentId), lock)) {
      return;
    }
    const existing = (await deps.kv.getJson(lockKey(environmentId))) as {
      acquiredAt?: string;
    } | null;
    const age =
      existing?.acquiredAt === undefined
        ? Infinity
        : now().getTime() - Date.parse(existing.acquiredAt);
    if (age > lockTtlMs) {
      await deps.kv.delete(lockKey(environmentId));
      if (await deps.kv.createIfAbsent(lockKey(environmentId), lock)) {
        return;
      }
    }
    throw new HttpError(
      409,
      "sync_in_progress",
      "Another sync to this environment is running. Try again when it has finished.",
    );
  };

  return {
    sync: async (caller, request) => {
      // 1. Recompute the diff exactly as it would be applied.
      const prepared = await deps.diff.prepare(request.environmentId, request.entities);
      const { target, analysis } = prepared;

      // 2. Typed confirmation of the target.
      if (request.confirmProjectName.trim() !== target.projectName) {
        throw new HttpError(
          400,
          "confirmation_mismatch",
          `Type the project name "${target.projectName}" exactly to confirm.`,
        );
      }

      // 3. Nothing may have changed since the user confirmed.
      if (prepared.diffHash !== request.diffHash) {
        throw new HttpError(
          409,
          "diff_changed",
          "The master or the client changed since you compared. Compare again and confirm the new diff.",
        );
      }

      if (analysis.blocks.length > 0) {
        throw new HttpError(409, "blocked", "This diff has blocking problems. Resolve them first.");
      }
      if (analysis.destructive.length > 0 && !request.confirmDestructive) {
        throw new HttpError(
          400,
          "destructive_not_confirmed",
          "This diff removes content. Confirm the destructive changes to continue.",
        );
      }
      if (analysis.changes.length === 0) {
        return { status: "nothing_to_sync" };
      }

      // 4. One sync per environment.
      await acquireLock(target.environmentId, caller);
      try {
        const event = await deps.audit.begin({
          actor: { userId: caller.userId, email: caller.email },
          action: "sync.run",
          target: target.environmentId,
        });
        const operations = countOperations(prepared);

        // 5. Backup first. No backup, no sync.
        let backupId: string;
        try {
          backupId = (await deps.backups.create(caller, target.environmentId, "pre-sync")).id;
        } catch (error) {
          await deps.audit.complete(event, "failed", { stage: "backup" });
          throw error;
        }

        const ref = { environmentId: target.environmentId, apiKey: prepared.targetKey };

        // 6. data-ops validation (types or collections in use, element type changes).
        let problems: ReadonlyArray<string>;
        try {
          problems = await deps.engine.validate(ref, prepared.model);
        } catch (error) {
          log("data-ops validation failed to run", error);
          await deps.audit.complete(event, "failed", { stage: "validation", backupId });
          throw new HttpError(
            502,
            "validation_error",
            "The sync could not be validated. Nothing was changed. Try again later.",
          );
        }
        if (problems.length > 0) {
          await deps.audit.complete(event, "failed", {
            stage: "validation",
            backupId,
            problems: problems.length,
          });
          return { status: "validation_failed", backupId, problems };
        }

        // 7. Apply. data-ops applies operations one by one; it is not transactional.
        try {
          await deps.engine.apply(ref, prepared.model, prepared.entities);
        } catch (error) {
          log("data-ops sync failed", error);
          await deps.audit.complete(event, "failed", {
            stage: "apply",
            backupId,
            error: error instanceof Error ? error.name : "UnknownError",
          });
          throw new HttpError(
            502,
            "sync_failed",
            `The sync stopped partway. Changes are applied one by one, so some may already be in the client. Compare again to see what is left. The backup made before the sync is ${backupId}.`,
          );
        }

        await deps.audit.complete(event, "succeeded", {
          backupId,
          operations,
          entities: prepared.entities.join(","),
        });
        return {
          status: "succeeded",
          backupId,
          operations,
          projectName: target.projectName,
          environmentName: target.environmentName,
        };
      } finally {
        await deps.kv.delete(lockKey(target.environmentId)).catch((error: unknown) => {
          log("Releasing the sync lock failed", error);
        });
      }
    },
  };
};
