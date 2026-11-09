import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { SubscriptionClient, SubscriptionUser } from "../kontent/subscriptionClient.js";

/**
 * Who is calling, as confirmed by the Subscription API. The user ID itself comes from
 * the browser (the Kontent.ai custom app context is not signed), so this is a check
 * that the claimed user exists and is allowed, not proof of identity. The access
 * secret is the other half of the check.
 */
export type Caller = Readonly<{
  userId: string;
  email: string;
  name: string | null;
  roles: ReadonlyArray<string>;
}>;

export const accessSecretHeader = "x-app-access-secret";
export const userIdHeader = "x-kontent-user-id";
export const userEmailHeader = "x-kontent-user-email";

export class AccessDeniedError extends HttpError {
  override readonly name = "AccessDeniedError";
}

export type AccessGuard = Readonly<{ check: (request: Request) => Promise<Caller> }>;

const cacheTtlMs = 60_000;

const secretsMatch = (given: string, expected: string): boolean => {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Roles the user holds in the master environment, if they are active there. */
const masterRoles = (user: SubscriptionUser, masterEnvironmentId: string) => {
  const environment = user.projects
    .flatMap((project) => project.environments)
    .find((env) => env.id.toLowerCase() === masterEnvironmentId);
  if (environment === undefined || !environment.is_user_active) {
    return null;
  }
  return environment.collection_groups.flatMap((group) => group.roles);
};

export const createAccessGuard = (
  config: Pick<AppConfig, "accessSecret" | "masterEnvironmentId" | "allowedRoles">,
  subscription: Pick<SubscriptionClient, "getUser">,
  now: () => number = Date.now,
): AccessGuard => {
  const cache = new Map<string, { expires: number; result: Promise<SubscriptionUser | null> }>();

  const lookupUser = async (userId: string) => {
    const cached = cache.get(userId);
    if (cached !== undefined && cached.expires > now()) {
      return await cached.result;
    }
    const result = subscription.getUser(userId);
    cache.set(userId, { expires: now() + cacheTtlMs, result });
    // Do not cache failures: a Subscription API outage should not lock users out for a minute.
    result.catch(() => cache.delete(userId));
    return await result;
  };

  return {
    check: async (request) => {
      const secret = request.headers.get(accessSecretHeader) ?? "";
      if (!secretsMatch(secret, config.accessSecret)) {
        throw new AccessDeniedError(
          401,
          "invalid_access_secret",
          "Missing or invalid access secret",
        );
      }

      const userId = request.headers.get(userIdHeader)?.trim() ?? "";
      if (userId === "") {
        throw new AccessDeniedError(401, "missing_user", "Missing Kontent.ai user ID");
      }

      const user = await lookupUser(userId);
      const roles = user === null ? null : masterRoles(user, config.masterEnvironmentId);
      if (user === null || roles === null) {
        throw new AccessDeniedError(
          403,
          "not_allowed",
          "This user is not an active user of the master environment",
        );
      }

      // Cross-check: the email from the context must match the Subscription API record.
      const claimedEmail = request.headers.get(userEmailHeader)?.trim().toLowerCase();
      if (claimedEmail !== undefined && claimedEmail !== user.email.toLowerCase()) {
        throw new AccessDeniedError(403, "not_allowed", "User details do not match");
      }

      const allowed = roles.some(
        (role) =>
          config.allowedRoles.has(role.id) ||
          (role.codename != null && config.allowedRoles.has(role.codename)),
      );
      if (!allowed) {
        throw new AccessDeniedError(
          403,
          "role_not_allowed",
          "Your role in the master environment does not allow using this app",
        );
      }

      const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
      return {
        userId: user.id,
        email: user.email,
        name: name === "" ? null : name,
        roles: roles.map((role) => role.name),
      };
    },
  };
};
