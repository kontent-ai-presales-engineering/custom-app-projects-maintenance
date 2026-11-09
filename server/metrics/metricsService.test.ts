import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { keyVariableName } from "../keys/envKeys.js";
import type { SubscriptionUser } from "../kontent/subscriptionClient.js";
import { createInMemoryKvStore } from "../storage/kvStore.js";
import { clientEnvId, clientProjectId } from "../testing/fixtures.js";
import { createMetricsService } from "./metricsService.js";

const caller: Caller = { userId: "u1", email: "ada@example.com", name: "Ada", roles: [] };

const user = (
  id: string,
  active: boolean,
  projectIds: ReadonlyArray<string>,
): SubscriptionUser => ({
  id,
  email: `${id}@example.com`,
  projects: projectIds.map((projectId) => ({
    id: projectId,
    name: projectId,
    environments: [{ id: "e", name: "Production", is_user_active: active, collection_groups: [] }],
  })),
});

const setup = (
  options: Readonly<{
    users?: () => Promise<ReadonlyArray<SubscriptionUser>>;
    countItems?: () => Promise<number>;
    env?: Record<string, string>;
    now?: () => number;
  }> = {},
) => {
  const kv = createInMemoryKvStore();
  const listUsers = vi.fn(
    options.users ??
      (async () =>
        await Promise.resolve([
          user("a", true, [clientProjectId.toUpperCase()]),
          user("b", false, [clientProjectId]),
          user("c", true, ["other"]),
        ])),
  );
  const service = createMetricsService({
    projects: {
      locate: async () =>
        await Promise.resolve({
          environmentId: clientEnvId,
          environmentName: "Production",
          projectId: clientProjectId,
          projectName: "Client A",
          isMasterProject: false,
        }),
    },
    subscription: { listUsers },
    env: () => options.env ?? { [keyVariableName(clientEnvId)]: "client-key" },
    managementClient: () => ({
      countItems: options.countItems ?? (async () => await Promise.resolve(1234)),
      listTypes: async () =>
        await Promise.resolve([
          { id: "t1", codename: "article", elements: [] },
          { id: "t2", codename: "page", elements: [] },
        ]),
    }),
    kv,
    now: options.now ?? (() => Date.parse("2026-11-09T12:00:00.000Z")),
  });
  return { service, listUsers };
};

describe("metrics service", () => {
  it("counts users per project, total and active", async () => {
    const { projects, usersError } = await setup().service.overview();

    expect(projects[clientProjectId]).toEqual({ total: 2, active: 1 });
    expect(projects.other).toEqual({ total: 1, active: 1 });
    expect(usersError).toBeNull();
  });

  it("counts content items and types of an environment and stores them", async () => {
    const { service } = setup();

    const metrics = await service.refresh(caller, clientEnvId);

    expect(metrics).toMatchObject({
      environmentId: clientEnvId,
      contentItems: 1234,
      contentTypes: 2,
      countedBy: { email: "ada@example.com" },
      error: null,
    });
    expect((await service.overview()).environments[clientEnvId]).toEqual(metrics);
  });

  it("stores what it could count, never 0 for a failed count", async () => {
    const { service } = setup({ countItems: async () => await Promise.reject(new Error("403")) });

    const metrics = await service.refresh(caller, clientEnvId);

    expect(metrics.contentItems).toBeNull();
    expect(metrics.contentTypes).toBe(2);
    expect(metrics.error).toContain("Read content");
  });

  it("still returns stored counts when the user listing fails, and retries it next time", async () => {
    const users = vi
      .fn<() => Promise<ReadonlyArray<SubscriptionUser>>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([]);
    const { service } = setup({ users });

    expect((await service.overview()).usersError).not.toBeNull();
    expect((await service.overview()).usersError).toBeNull();
  });

  it("caches user counts for 5 minutes", async () => {
    let time = 0;
    const { service, listUsers } = setup({ now: () => time });
    await service.overview();
    time = 4 * 60 * 1000;
    await service.overview();
    time = 6 * 60 * 1000;
    await service.overview();

    expect(listUsers).toHaveBeenCalledTimes(2);
  });

  it("needs a key and a valid environment ID", async () => {
    await expect(setup({ env: {} }).service.refresh(caller, clientEnvId)).rejects.toMatchObject({
      code: "key_missing",
    });
    await expect(setup().service.refresh(caller, "nope")).rejects.toMatchObject({ status: 400 });
  });
});
