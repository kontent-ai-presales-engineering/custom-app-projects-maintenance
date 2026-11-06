import { type AccessGuard, createAccessGuard } from "./access/accessGuard.js";
import { type AuditLog, createAuditLog } from "./audit/auditLog.js";
import { type AppConfig, loadConfig } from "./config.js";
import { createSubscriptionClient, type SubscriptionClient } from "./kontent/subscriptionClient.js";
import { createVercelBlobKvStore } from "./storage/vercelBlobKvStore.js";

/**
 * Production wiring, created once per function instance and reused while it is warm.
 * Tests build the same services with fakes instead.
 */
export type Runtime = Readonly<{
  config: AppConfig;
  subscription: SubscriptionClient;
  guard: AccessGuard;
  audit: AuditLog;
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
  cached = {
    config,
    subscription,
    guard: createAccessGuard(config, subscription),
    audit: createAuditLog(createVercelBlobKvStore("model-sync")),
  };
  return cached;
};
