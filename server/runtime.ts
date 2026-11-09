import { type AccessGuard, createAccessGuard } from "./access/accessGuard.js";
import { type AuditLog, createAuditLog } from "./audit/auditLog.js";
import { type BackupService, createBackupService } from "./backup/backupService.js";
import { type AppConfig, loadConfig } from "./config.js";
import { createDriftService, type DriftService } from "./drift/driftService.js";
import { createExclusionService, type ExclusionService } from "./exclusions/exclusionService.js";
import { createDeliveryClient } from "./kontent/deliveryClient.js";
import { createEnvironmentClient } from "./kontent/environmentClient.js";
import { createManagementClient } from "./kontent/managementClient.js";
import { createSubscriptionClient, type SubscriptionClient } from "./kontent/subscriptionClient.js";
import { createMetricsService, type MetricsService } from "./metrics/metricsService.js";
import { createOnboardingService, type OnboardingService } from "./onboarding/onboardingService.js";
import { createProjectService, type ProjectService } from "./projects/projectService.js";
import { createReleaseService, type ReleaseService } from "./releases/releaseService.js";
import { createRolloutService, type RolloutService } from "./rollout/rolloutService.js";
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
  exclusions: ExclusionService;
  drift: DriftService;
  rollout: RolloutService;
  releases: ReleaseService;
  onboarding: OnboardingService;
  metrics: MetricsService;
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
  const backups = createBackupService({
    config,
    projects,
    env: () => process.env,
    snapshotter: createDataOpsSnapshotter(),
    kv,
    audit,
  });
  const exclusions = createExclusionService({ projects, kv, audit });
  const releases = createReleaseService({
    config,
    projects,
    env: () => process.env,
    snapshotter: createDataOpsSnapshotter(),
    kv,
    audit,
  });
  const diff = createDiffService({
    config,
    projects,
    backups,
    exclusions,
    releases,
    env: () => process.env,
    engine: dataOpsDiffEngine,
    managementClient,
    deliveryClient: (environmentId, apiKey) => createDeliveryClient({ environmentId, apiKey }),
  });
  cached = {
    config,
    subscription,
    guard: createAccessGuard(config, subscription),
    audit,
    projects,
    diff,
    backups,
    exclusions,
    drift: createDriftService({ diff, kv }),
    rollout: createRolloutService({ diff, managementClient }),
    releases,
    metrics: createMetricsService({
      projects,
      subscription,
      env: () => process.env,
      managementClient,
      kv,
    }),
    onboarding: createOnboardingService({
      projects,
      env: () => process.env,
      environmentClient: (environmentId, apiKey) =>
        createEnvironmentClient({ environmentId, apiKey }),
      audit,
    }),
    sync: createSyncService({
      diff,
      backups,
      releases,
      engine: dataOpsSyncEngine,
      kv,
      audit,
    }),
  };
  return cached;
};
