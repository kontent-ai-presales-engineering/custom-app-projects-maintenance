import { type AccessGuard, createAccessGuard } from "./access/accessGuard.js";
import { type AuditLog, createAuditLog } from "./audit/auditLog.js";
import { type BackupService, createBackupService } from "./backup/backupService.js";
import { type AppConfig, loadConfig } from "./config.js";
import { createDeliveryClient } from "./kontent/deliveryClient.js";
import { createManagementClient } from "./kontent/managementClient.js";
import { createSubscriptionClient, type SubscriptionClient } from "./kontent/subscriptionClient.js";
import { createProjectService, type ProjectService } from "./projects/projectService.js";
import { createVercelBlobKvStore } from "./storage/vercelBlobKvStore.js";
import { createDataOpsSnapshotter, dataOpsDiffEngine, dataOpsSyncEngine } from "./sync/dataOps.js";
import { createDiffService, type DiffService } from "./sync/diffService.js";
import { createSyncService, type SyncService } from "./sync/syncService.js";

/**
 * Production wiring, created once per function instance and reused while it is warm.
 * Tests build the same services with fakes instead.
 */
export type Runtime = Readonly<{
  config: AppConfig;
  subscription: SubscriptionClient;
  guard: AccessGuard;
  audit: AuditLog;
  projects: ProjectService;
  diff: DiffService;
  backups: BackupService;
  sync: SyncService;
}>;

let cached: Runtime | undefined;

export const getRuntime = (): Runtime => {
  if (cached !== undefined) {
    return cached;
  }
  const config = loadConfig(process.env);
  const subscription = createSubscriptionClient({
    subscriptionId: config.subscriptionId,
    apiKey: config.subscriptionApiKey,
  });
  const managementClient = (environmentId: string, apiKey: string) =>
    createManagementClient({ environmentId, apiKey });
  const projects = createProjectService({
    config,
    subscription,
    env: () => process.env,
    managementClient,
  });
  const kv = createVercelBlobKvStore("model-sync");
  const audit = createAuditLog(kv);
  const diff = createDiffService({
    config,
    projects,
    env: () => process.env,
    engine: dataOpsDiffEngine,
    managementClient,
    deliveryClient: (environmentId, apiKey) => createDeliveryClient({ environmentId, apiKey }),
  });
  const backups = createBackupService({
    config,
    projects,
    env: () => process.env,
    snapshotter: createDataOpsSnapshotter(),
    kv,
    audit,
  });
  cached = {
    config,
    subscription,
    guard: createAccessGuard(config, subscription),
    audit,
    projects,
    diff,
    backups,
    sync: createSyncService({ diff, backups, engine: dataOpsSyncEngine, kv, audit }),
  };
  return cached;
};
