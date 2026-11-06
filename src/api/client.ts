export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
}>;

export const createApiClient = (identity: ApiIdentity): ApiClient => ({
  fetchJson: async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(path, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
        "x-app-access-secret": identity.accessSecret,
        "x-kontent-user-id": identity.userId,
        "x-kontent-user-email": identity.userEmail,
      },
    });

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (body as ErrorBody | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "http_error",
        error?.message ?? `Request failed with status ${response.status}`,
      );
    }
    return body as T;
  },
});

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

export type DiffResult = Readonly<{
  source: Readonly<{ environmentId: string }>;
  target: Readonly<{
    environmentId: string;
    environmentName: string;
    projectId: string;
    projectName: string;
  }>;
  entities: ReadonlyArray<SelectableEntity>;
  generatedAt: string;
  inSync: boolean;
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
  reportHtml: string;
}>;

export const runDiff = async (
  client: ApiClient,
  environmentId: string,
  entities: ReadonlyArray<SelectableEntity>,
) =>
  await client.fetchJson<DiffResult>("/api/diff", {
    method: "POST",
    body: JSON.stringify({ environmentId, entities }),
  });
