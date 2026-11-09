export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The parsed response body, for responses that carry more than an error. */
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

type ErrorBody = { readonly error?: { readonly code?: string; readonly message?: string } };

export type ApiIdentity = Readonly<{
  /** From the custom app Parameters {JSON}: { "accessSecret": "..." }. */
  accessSecret: string;
  /** From the Kontent.ai custom app context. The backend verifies both with the Subscription API. */
  userId: string;
  userEmail: string;
}>;

export type ApiClient = Readonly<{
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** For non-JSON responses such as downloads. Throws ApiError on an error status. */
  fetchBlob: (path: string) => Promise<Blob>;
}>;

const toApiError = (status: number, body: unknown) => {
  const error = (body as ErrorBody | null)?.error;
  return new ApiError(
    status,
    error?.code ?? "http_error",
    error?.message ?? `Request failed with status ${status}`,
    body,
  );
};

export const createApiClient = (identity: ApiIdentity): ApiClient => {
  const identityHeaders = {
    "x-app-access-secret": identity.accessSecret,
    "x-kontent-user-id": identity.userId,
    "x-kontent-user-email": identity.userEmail,
  };

  return {
    fetchJson: async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(path, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
          ...identityHeaders,
        },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw toApiError(response.status, body);
      }
      return body as T;
    },

    fetchBlob: async (path: string): Promise<Blob> => {
      const response = await fetch(path, { headers: identityHeaders });
      if (!response.ok) {
        throw toApiError(response.status, await response.json().catch(() => null));
      }
      return await response.blob();
    },
  };
};

export type KeyStatus = Readonly<{
  configured: boolean;
  source: "environment" | "project" | null;
  variableName: string;
}>;

export type Me = Readonly<{
  user: Readonly<{ email: string; name: string | null; roles: ReadonlyArray<string> }>;
  master: Readonly<{ environmentId: string; key: KeyStatus }>;
}>;

export const getMe = async (client: ApiClient) => await client.fetchJson<Me>("/api/me");

/** Reads the access secret from the custom app parameters, or null when it is missing. */
export const readAccessSecret = (appConfig: unknown): string | null => {
  if (typeof appConfig !== "object" || appConfig === null || !("accessSecret" in appConfig)) {
    return null;
  }
  const { accessSecret } = appConfig as { accessSecret: unknown };
  return typeof accessSecret === "string" && accessSecret.trim() !== ""
    ? accessSecret.trim()
    : null;
};

export type EnvironmentView = Readonly<{
  id: string;
  name: string;
  isMaster: boolean;
  key: KeyStatus;
}>;

export type ProjectView = Readonly<{
  id: string;
  name: string;
  isActive: boolean;
  isMasterProject: boolean;
  environments: ReadonlyArray<EnvironmentView>;
}>;

export type ProjectOverviewData = Readonly<{
  projects: ReadonlyArray<ProjectView>;
  masterFound: boolean;
}>;

export type ConnectionResult =
  | Readonly<{
      status: "ok";
      projectName: string;
      environmentName: string;
      isProduction: boolean | null;
      keySource: "environment" | "project";
    }>
  | Readonly<{ status: "key_missing"; variableName: string }>
  | Readonly<{
      status: "key_rejected" | "no_content_model_access" | "wrong_environment" | "error";
      variableName: string;
      message: string;
    }>;

export const getProjects = async (client: ApiClient) =>
  await client.fetchJson<ProjectOverviewData>("/api/projects");

export const testConnection = async (client: ApiClient, environmentId: string) =>
  await client.fetchJson<ConnectionResult>("/api/test-connection", {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });

export const selectableEntities = [
  { id: "contentTypes", label: "Content types", default: true },
  { id: "contentTypeSnippets", label: "Snippets", default: true },
  { id: "taxonomies", label: "Taxonomies", default: true },
  { id: "collections", label: "Collections", default: false },
  { id: "spaces", label: "Spaces", default: false },
  { id: "languages", label: "Languages", default: false },
  { id: "workflows", label: "Workflows", default: false },
] as const;

export type SelectableEntity = (typeof selectableEntities)[number]["id"];

export type Impact = Readonly<{
  latest: number | null;
  published: number | null;
  unknownReasons: ReadonlyArray<string>;
}>;

export type DiffSource =
  | Readonly<{ kind: "master"; environmentId: string }>
  | Readonly<{ kind: "backup"; backupId: string; createdAt: string }>
  | Readonly<{ kind: "release"; releaseId: string; version: string; createdAt: string }>;

export type DiffResult = Readonly<{
  source: DiffSource;
  target: Readonly<{
    environmentId: string;
    environmentName: string;
    projectId: string;
    projectName: string;
  }>;
  entities: ReadonlyArray<SelectableEntity>;
  generatedAt: string;
  /** Fingerprint of the diff; sent back to confirm exactly this diff when syncing. */
  diffHash: string;
  inSync: boolean;
  selection: Readonly<{
    items: ItemSelection;
    dependencies: ReadonlyArray<
      Readonly<{ entity: SelectableEntity; codename: string; reason: string }>
    >;
  }> | null;
  changes: ReadonlyArray<
    Readonly<{
      entity: string;
      codename: string;
      kind: "added" | "updated" | "deleted";
      operations: ReadonlyArray<string>;
    }>
  >;
  destructive: ReadonlyArray<
    Readonly<{ id: string; entity: string; owner: string; description: string; impact: Impact }>
  >;
  blocks: ReadonlyArray<Readonly<{ entity: string; owner: string; reason: string }>>;
  warnings: ReadonlyArray<Readonly<{ entity: string; owner: string; message: string }>>;
  keptClientItems: ReadonlyArray<string>;
  excludedItems: ReadonlyArray<
    Readonly<{ entity: SelectableEntity; codename: string; kind: "added" | "updated" | "deleted" }>
  >;
  reportHtml: string;
}>;

/** Compares with the master, or with a backup of the same environment when restoreFrom is set. */
export type ItemSelection = Readonly<Partial<Record<SelectableEntity, ReadonlyArray<string>>>>;

export const runDiff = async (
  client: ApiClient,
  environmentId: string,
  entities: ReadonlyArray<SelectableEntity>,
  options: Readonly<{
    restoreFrom?: string | undefined;
    items?: ItemSelection | undefined;
    release?: string | undefined;
  }> = {},
) =>
  await client.fetchJson<DiffResult>("/api/diff", {
    method: "POST",
    body: JSON.stringify({ environmentId, entities, ...options }),
  });

export type BackupMetadata = Readonly<{
  id: string;
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  createdBy: Readonly<{ userId: string; email: string }>;
  reason: "manual" | "pre-sync" | "pre-restore";
  counts: Readonly<Record<string, number>>;
}>;

export const listBackups = async (client: ApiClient, environmentId: string) =>
  (
    await client.fetchJson<{ backups: ReadonlyArray<BackupMetadata> }>(
      `/api/backups?environmentId=${encodeURIComponent(environmentId)}`,
    )
  ).backups;

export const createBackup = async (client: ApiClient, environmentId: string) =>
  await client.fetchJson<BackupMetadata>("/api/backups", {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });

/** Downloads a backup through the API (headers carry the access check) and saves it as a file. */
export const downloadBackup = async (client: ApiClient, backup: BackupMetadata) => {
  const blob = await client.fetchBlob(
    `/api/backup-download?environmentId=${encodeURIComponent(backup.environmentId)}&backupId=${encodeURIComponent(backup.id)}`,
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `model-backup-${backup.environmentId}-${backup.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

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

export type SyncRequest = Readonly<{
  environmentId: string;
  entities: ReadonlyArray<SelectableEntity>;
  diffHash: string;
  confirmProjectName: string;
  confirmDestructive: boolean;
  restoreFrom?: string | undefined;
  items?: ItemSelection | undefined;
  release?: string | undefined;
}>;

/** Runs a sync. A validation failure (HTTP 409 with problems) is returned, not thrown. */
export const runSync = async (client: ApiClient, request: SyncRequest): Promise<SyncOutcome> => {
  try {
    return await client.fetchJson<SyncOutcome>("/api/sync", {
      method: "POST",
      body: JSON.stringify(request),
    });
  } catch (error) {
    const body = error instanceof ApiError ? (error.body as { status?: unknown } | null) : null;
    if (body?.status === "validation_failed") {
      return body as SyncOutcome;
    }
    throw error;
  }
};

export type AuditEntry = Readonly<{
  id: string;
  at: string;
  actor: Readonly<{ userId: string; email: string }>;
  action:
    | "backup.create"
    | "sync.run"
    | "backup.restore"
    | "exclusions.update"
    | "release.create"
    | "environment.clone";
  target: string | null;
  completedAt: string | null;
  details: Readonly<Record<string, string | number>> | null;
  targetName: Readonly<{ projectName: string; environmentName: string }> | null;
  status: "succeeded" | "failed" | "pending" | "incomplete";
}>;

export type AuditPage = Readonly<{ entries: ReadonlyArray<AuditEntry>; nextCursor: string | null }>;

export const getAudit = async (client: ApiClient, before?: string) =>
  await client.fetchJson<AuditPage>(
    `/api/audit?limit=50${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
  );

export type ClientExclusions = Readonly<{
  projectId: string;
  items: ItemSelection;
  updatedAt: string | null;
  updatedBy: Readonly<{ userId: string; email: string }> | null;
}>;

export const getExclusions = async (client: ApiClient, projectId: string) =>
  await client.fetchJson<ClientExclusions>(
    `/api/exclusions?projectId=${encodeURIComponent(projectId)}`,
  );

export const saveExclusions = async (client: ApiClient, projectId: string, items: ItemSelection) =>
  await client.fetchJson<ClientExclusions>("/api/exclusions", {
    method: "PUT",
    body: JSON.stringify({ projectId, items }),
  });

export type DriftSummary = Readonly<{
  environmentId: string;
  projectId: string;
  projectName: string;
  environmentName: string;
  checkedAt: string;
  checkedBy: Readonly<{ userId: string; email: string }>;
  entities: ReadonlyArray<string>;
  status: "in_sync" | "drift" | "blocked" | "error";
  changes: number;
  destructive: number;
  blocks: number;
  excluded: number;
  error: string | null;
}>;

export const getDrift = async (client: ApiClient) =>
  (await client.fetchJson<{ summaries: ReadonlyArray<DriftSummary> }>("/api/drift")).summaries;

export const checkDrift = async (client: ApiClient, environmentId: string) =>
  await client.fetchJson<DriftSummary>("/api/drift", {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });

export type RolloutPlanEntry = Readonly<{
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  isProduction: boolean | null;
  stage: "non-production" | "production";
  diffHash: string;
  status: "ready" | "in_sync" | "blocked";
  changes: number;
  destructive: number;
  excluded: number;
  blocks: ReadonlyArray<string>;
}>;

export const planRollout = async (
  client: ApiClient,
  environmentId: string,
  entities: ReadonlyArray<SelectableEntity>,
  release?: string,
) =>
  await client.fetchJson<RolloutPlanEntry>("/api/rollout-plan", {
    method: "POST",
    body: JSON.stringify({ environmentId, entities, release }),
  });

export type ReleaseMetadata = Readonly<{
  id: string;
  version: string;
  notes: string;
  createdAt: string;
  createdBy: Readonly<{ userId: string; email: string }>;
  counts: Readonly<Record<string, number>>;
}>;

export type ClientRelease = Readonly<{
  releaseId: string | null;
  version: string | null;
  syncedAt: string;
  syncedBy: Readonly<{ userId: string; email: string }>;
}>;

export type ReleasesData = Readonly<{
  releases: ReadonlyArray<ReleaseMetadata>;
  clientReleases: Readonly<Record<string, ClientRelease>>;
}>;

export const getReleases = async (client: ApiClient) =>
  await client.fetchJson<ReleasesData>("/api/releases");

export const createRelease = async (client: ApiClient, version: string, notes: string) =>
  await client.fetchJson<ReleaseMetadata>("/api/releases", {
    method: "POST",
    body: JSON.stringify({ version, notes }),
  });

export const cloneEnvironment = async (
  client: ApiClient,
  sourceEnvironmentId: string,
  name: string,
  copyContent: boolean,
) =>
  await client.fetchJson<Readonly<{ environmentId: string; name: string }>>(
    "/api/clone-environment",
    { method: "POST", body: JSON.stringify({ sourceEnvironmentId, name, copyContent }) },
  );

export const getCloningState = async (
  client: ApiClient,
  projectId: string,
  environmentId: string,
) =>
  (
    await client.fetchJson<{ state: string }>(
      `/api/clone-environment?projectId=${encodeURIComponent(projectId)}&environmentId=${encodeURIComponent(environmentId)}`,
    )
  ).state;

export type EnvironmentMetrics = Readonly<{
  environmentId: string;
  contentItems: number | null;
  contentTypes: number | null;
  countedAt: string;
  countedBy: Readonly<{ userId: string; email: string }>;
  error: string | null;
}>;

export type MetricsOverview = Readonly<{
  environments: Readonly<Record<string, EnvironmentMetrics>>;
  projects: Readonly<Record<string, Readonly<{ total: number; active: number }>>>;
  usersError: string | null;
}>;

export const getMetrics = async (client: ApiClient) =>
  await client.fetchJson<MetricsOverview>("/api/metrics");

export const refreshMetrics = async (client: ApiClient, environmentId: string) =>
  await client.fetchJson<EnvironmentMetrics>("/api/metrics", {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });
