/**
 * Management API keys live in environment variables, one per Kontent.ai environment:
 *
 *   KONTENT_MAPI_KEY_<environment ID with "-" replaced by "_">
 *
 * with an optional fallback per project:
 *
 *   KONTENT_MAPI_KEY_<project ID with "-" replaced by "_">
 *
 * Variables are read on every lookup, so a new client needs no code change (only a
 * redeploy, because hosting platforms apply new variables to new deployments).
 * Values are never returned to the browser; only whether a key exists.
 */

const prefix = "KONTENT_MAPI_KEY_";

export const keyVariableName = (id: string): string =>
  `${prefix}${id.trim().toLowerCase().replaceAll("-", "_")}`;

export type KeySource = "environment" | "project";

export type ResolvedKey = Readonly<{ value: string; source: KeySource; variableName: string }>;

export type KeyStatus = Readonly<{
  configured: boolean;
  source: KeySource | null;
  /** The variable that holds the key, or the one to create when it is missing. */
  variableName: string;
}>;

type Env = Readonly<Record<string, string | undefined>>;

/** Exact name first, then case-insensitive, because people paste IDs in either case. */
const lookup = (env: Env, name: string): string | undefined => {
  const exact = env[name]?.trim();
  if (exact) {
    return exact;
  }
  const lower = name.toLowerCase();
  const match = Object.entries(env)
    .find(([key]) => key.toLowerCase() === lower)?.[1]
    ?.trim();
  return match === "" ? undefined : match;
};

export const resolveManagementKey = (
  env: Env,
  ids: Readonly<{ environmentId: string; projectId?: string | undefined }>,
): ResolvedKey | null => {
  const environmentVar = keyVariableName(ids.environmentId);
  const environmentKey = lookup(env, environmentVar);
  if (environmentKey !== undefined) {
    return { value: environmentKey, source: "environment", variableName: environmentVar };
  }
  if (ids.projectId !== undefined) {
    const projectVar = keyVariableName(ids.projectId);
    const projectKey = lookup(env, projectVar);
    if (projectKey !== undefined) {
      return { value: projectKey, source: "project", variableName: projectVar };
    }
  }
  return null;
};

/** Optional Delivery API key, only needed when secure access is enabled for the environment. */
export const deliveryKeyVariableName = (environmentId: string): string =>
  `KONTENT_DELIVERY_KEY_${environmentId.trim().toLowerCase().replaceAll("-", "_")}`;

export const resolveDeliveryKey = (env: Env, environmentId: string): string | null =>
  lookup(env, deliveryKeyVariableName(environmentId)) ?? null;

export const managementKeyStatus = (
  env: Env,
  ids: Readonly<{ environmentId: string; projectId?: string | undefined }>,
): KeyStatus => {
  const resolved = resolveManagementKey(env, ids);
  return resolved === null
    ? { configured: false, source: null, variableName: keyVariableName(ids.environmentId) }
    : { configured: true, source: resolved.source, variableName: resolved.variableName };
};
