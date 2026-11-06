import { describe, expect, it, vi } from "vitest";
import { keyVariableName } from "../keys/envKeys.js";
import { KontentApiError } from "../kontent/kontentHttp.js";
import type { ManagementClient } from "../kontent/managementClient.js";
import type { SubscriptionProject } from "../kontent/subscriptionClient.js";
import { clientEnvId, clientProjectId, masterEnvId } from "../testing/fixtures.js";
import { createProjectService, UnknownEnvironmentError } from "./projectService.js";

const clientDevEnvId = "44444444-4444-4444-4444-444444444444";

const projects: ReadonlyArray<SubscriptionProject> = [
  {
    id: clientProjectId,
    name: "Client A",
    is_active: true,
    environments: [
      { id: clientEnvId, name: "Production" },
      { id: clientDevEnvId, name: "Dev" },
    ],
  },
  { id: "p-old", name: "Archived client", is_active: false, environments: [] },
  {
    id: "p-master",
    name: "Master",
    is_active: true,
    environments: [{ id: masterEnvId, name: "Production" }],
  },
];

const okClient = (overrides: Partial<ManagementClient> = {}): ManagementClient => {
  const base: ManagementClient = {
    getEnvironmentInfo: async () =>
      Promise.resolve({
        id: clientEnvId,
        name: "Client A",
        environment: "Production",
        is_production: true,
      }),
    checkContentModelAccess: async () => Promise.resolve(),
    listTypes: async () => Promise.resolve([]),
    listSnippets: async () => Promise.resolve([]),
    listTaxonomies: async () => Promise.resolve([]),
    listLanguages: async () => Promise.resolve([]),
    listVariantsOfType: async () => Promise.resolve([]),
    isUsedAsComponent: async () => Promise.resolve(false),
  };
  return { ...base, ...overrides };
};

const setup = (
  options: Readonly<{
    env?: Record<string, string>;
    client?: ManagementClient;
    listProjects?: () => Promise<ReadonlyArray<SubscriptionProject>>;
    now?: () => number;
  }> = {},
) => {
  const listProjects = vi.fn(options.listProjects ?? (async () => Promise.resolve(projects)));
  const managementClient = vi.fn((_id: string, _key: string) => options.client ?? okClient());
  const service = createProjectService({
    config: { masterEnvironmentId: masterEnvId },
    subscription: { listProjects },
    env: () => options.env ?? {},
    managementClient,
    now: options.now ?? (() => 0),
  });
  return { service, listProjects, managementClient };
};

describe("project overview", () => {
  it("lists the master project first, then active, then inactive projects", async () => {
    const { projects: views, masterFound } = await setup().service.overview();

    expect(views.map((p) => [p.name, p.isMasterProject, p.isActive])).toEqual([
      ["Master", true, true],
      ["Client A", false, true],
      ["Archived client", false, false],
    ]);
    expect(masterFound).toBe(true);
    expect(views[0]?.environments[0]?.isMaster).toBe(true);
  });

  it("shows key status per environment, with the project fallback, and never the value", async () => {
    const overview = await setup({
      env: { [keyVariableName(clientProjectId)]: "project-key-value" },
    }).service.overview();
    const clientA = overview.projects.find((p) => p.name === "Client A");

    expect(clientA?.environments.map((e) => [e.name, e.key.configured, e.key.source])).toEqual([
      ["Dev", true, "project"],
      ["Production", true, "project"],
    ]);
    expect(JSON.stringify(overview)).not.toContain("project-key-value");
  });

  it("names the variable to add for an environment without a key", async () => {
    const overview = await setup().service.overview();
    const production = overview.projects
      .find((p) => p.name === "Client A")
      ?.environments.find((e) => e.name === "Production");

    expect(production?.key).toEqual({
      configured: false,
      source: null,
      variableName: keyVariableName(clientEnvId),
    });
  });

  it("reports when the master environment is not in the subscription", async () => {
    const { masterFound } = await setup({
      listProjects: async () => Promise.resolve(projects.filter((p) => p.name !== "Master")),
    }).service.overview();

    expect(masterFound).toBe(false);
  });

  it("caches the subscription listing for 60 seconds and does not cache failures", async () => {
    let time = 0;
    const listProjects = vi
      .fn<() => Promise<ReadonlyArray<SubscriptionProject>>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(projects);
    const { service } = setup({ listProjects, now: () => time });

    await expect(service.overview()).rejects.toThrow("down");
    await service.overview();
    time = 30_000;
    await service.overview();
    time = 61_000;
    await service.overview();

    expect(listProjects).toHaveBeenCalledTimes(3);
  });
});

describe("test connection", () => {
  const withKey = { [keyVariableName(clientEnvId)]: "env-key" };

  it("succeeds when the key works and can read the content model", async () => {
    const { service, managementClient } = setup({ env: withKey });

    expect(await service.testConnection(clientEnvId.toUpperCase())).toEqual({
      status: "ok",
      projectName: "Client A",
      environmentName: "Production",
      isProduction: true,
      keySource: "environment",
    });
    expect(managementClient).toHaveBeenCalledWith(clientEnvId, "env-key");
  });

  it("refuses environments outside the subscription without calling the Management API", async () => {
    const { service, managementClient } = setup({ env: withKey });

    await expect(
      service.testConnection("99999999-9999-9999-9999-999999999999"),
    ).rejects.toBeInstanceOf(UnknownEnvironmentError);
    expect(managementClient).not.toHaveBeenCalled();
  });

  it("reports a missing key with the variable name", async () => {
    expect(await setup().service.testConnection(clientEnvId)).toEqual({
      status: "key_missing",
      variableName: keyVariableName(clientEnvId),
    });
  });

  it.each([
    [
      "rejected key",
      okClient({ getEnvironmentInfo: async () => Promise.reject(new KontentApiError(401, "x")) }),
      "key_rejected",
    ],
    [
      "key for another environment",
      okClient({ getEnvironmentInfo: async () => Promise.reject(new KontentApiError(403, "x")) }),
      "key_rejected",
    ],
    [
      "no content model permission",
      okClient({
        checkContentModelAccess: async () => Promise.reject(new KontentApiError(403, "x")),
      }),
      "no_content_model_access",
    ],
    [
      "API returns another environment",
      okClient({
        getEnvironmentInfo: async () =>
          Promise.resolve({ id: clientDevEnvId, name: "Client A", environment: "Dev" }),
      }),
      "wrong_environment",
    ],
    [
      "API unavailable",
      okClient({ getEnvironmentInfo: async () => Promise.reject(new KontentApiError(503, "x")) }),
      "error",
    ],
  ])("reports %s", async (_label, client, status) => {
    const result = await setup({ env: withKey, client }).service.testConnection(clientEnvId);

    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("env-key");
  });
});
