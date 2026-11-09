import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const guid = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a GUID")
  .transform((value) => value.toLowerCase());

const minSecretLength = 32;

const envSchema = z.object({
  KONTENT_SUBSCRIPTION_ID: z.string().trim().min(1),
  KONTENT_SUBSCRIPTION_API_KEY: z.string().trim().min(1),
  KONTENT_MASTER_ENVIRONMENT_ID: guid,
  CLIENT_PREFIX: optionalString.transform((value) => value ?? "client_"),
  APP_ACCESS_SECRET: z
    .string()
    .trim()
    .min(minSecretLength, `must be at least ${minSecretLength} characters`),
  ALLOWED_ROLES: csv.transform((roles) => (roles.length > 0 ? roles : ["project-manager"])),
});

export type AppConfig = Readonly<{
  subscriptionId: string;
  subscriptionApiKey: string;
  masterEnvironmentId: string;
  clientPrefix: string;
  accessSecret: string;
  /** Role IDs or codenames in the master environment that may use the app. */
  allowedRoles: ReadonlySet<string>;
}>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Reads and validates the fixed server configuration. Management API keys are not
 * part of it: they are looked up per environment at request time (see keys/envKeys).
 * Error messages name the variables, never their values.
 */
export const loadConfig = (env: Readonly<Record<string, string | undefined>>): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    );
    throw new ConfigError(`Invalid server configuration: ${problems.join("; ")}`);
  }
  const e = parsed.data;

  return {
    subscriptionId: e.KONTENT_SUBSCRIPTION_ID,
    subscriptionApiKey: e.KONTENT_SUBSCRIPTION_API_KEY,
    masterEnvironmentId: e.KONTENT_MASTER_ENVIRONMENT_ID,
    clientPrefix: e.CLIENT_PREFIX,
    accessSecret: e.APP_ACCESS_SECRET,
    allowedRoles: new Set(e.ALLOWED_ROLES),
  };
};
