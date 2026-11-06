import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { SubscriptionUser } from "../kontent/subscriptionClient.js";
import {
  accessSecret,
  contributor,
  masterEnvId,
  subscriptionUser,
  userId,
  validEnv,
} from "../testing/fixtures.js";
import {
  AccessDeniedError,
  accessSecretHeader,
  createAccessGuard,
  userEmailHeader,
  userIdHeader,
} from "./accessGuard.js";

const config = loadConfig(validEnv());

const request = (headers: Record<string, string>) =>
  new Request("https://app.example/api/me", { headers });

const validHeaders = {
  [accessSecretHeader]: accessSecret,
  [userIdHeader]: userId,
  [userEmailHeader]: "ADA@example.com",
};

const guardFor = (user: SubscriptionUser | null | Error, now = () => 0) => {
  const getUser = vi.fn(async () =>
    user instanceof Error ? Promise.reject(user) : Promise.resolve(user),
  );
  return { guard: createAccessGuard(config, { getUser }, now), getUser };
};

const denial = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof AccessDeniedError ? [error.status, error.code] : error;
};

describe("access guard", () => {
  it("allows an active project manager of the master environment", async () => {
    const { guard } = guardFor(subscriptionUser());

    expect(await guard.check(request(validHeaders))).toEqual({
      userId,
      email: "ada@example.com",
      name: "Ada Lovelace",
      roles: ["Project manager"],
    });
  });

  it("allows a custom role listed by ID", async () => {
    const custom = createAccessGuard(loadConfig(validEnv({ ALLOWED_ROLES: "role-contrib" })), {
      getUser: async () => Promise.resolve(subscriptionUser({ roles: [contributor] })),
    });

    expect((await custom.check(request(validHeaders))).roles).toEqual(["Contributor"]);
  });

  it.each([
    [
      "missing secret",
      { ...validHeaders, [accessSecretHeader]: "" },
      [401, "invalid_access_secret"],
    ],
    [
      "wrong secret",
      { ...validHeaders, [accessSecretHeader]: "x".repeat(40) },
      [401, "invalid_access_secret"],
    ],
    ["missing user ID", { ...validHeaders, [userIdHeader]: " " }, [401, "missing_user"]],
    [
      "email mismatch",
      { ...validHeaders, [userEmailHeader]: "eve@example.com" },
      [403, "not_allowed"],
    ],
  ])("rejects a request: %s", async (_label, headers, expected) => {
    expect(await denial(guardFor(subscriptionUser()).guard.check(request(headers)))).toEqual(
      expected,
    );
  });

  it("does not call the Subscription API when the secret is wrong", async () => {
    const { guard, getUser } = guardFor(subscriptionUser());
    await denial(guard.check(request({ ...validHeaders, [accessSecretHeader]: "nope" })));

    expect(getUser).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown user", null, [403, "not_allowed"]],
    ["inactive in master", subscriptionUser({ active: false }), [403, "not_allowed"]],
    [
      "only in another environment",
      subscriptionUser({ environmentId: "other-env" }),
      [403, "not_allowed"],
    ],
    ["role not allowed", subscriptionUser({ roles: [contributor] }), [403, "role_not_allowed"]],
  ])("rejects a user: %s", async (_label, user, expected) => {
    expect(await denial(guardFor(user).guard.check(request(validHeaders)))).toEqual(expected);
  });

  it("matches the master environment ID case-insensitively", async () => {
    const { guard } = guardFor(subscriptionUser({ environmentId: masterEnvId.toUpperCase() }));

    await expect(guard.check(request(validHeaders))).resolves.toBeDefined();
  });

  it("caches user lookups for 60 seconds", async () => {
    let time = 0;
    const { guard, getUser } = guardFor(subscriptionUser(), () => time);
    await guard.check(request(validHeaders));
    time = 59_000;
    await guard.check(request(validHeaders));
    time = 61_000;
    await guard.check(request(validHeaders));

    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("does not cache Subscription API failures", async () => {
    const getUser = vi
      .fn<(id: string) => Promise<SubscriptionUser | null>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(subscriptionUser());
    const guard = createAccessGuard(config, { getUser }, () => 0);

    await expect(guard.check(request(validHeaders))).rejects.toThrow("down");
    await expect(guard.check(request(validHeaders))).resolves.toBeDefined();
  });
});
