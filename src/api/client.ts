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
