import { describe, expect, it, vi } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { createAuditLog } from "../audit/auditLog.js";
import { keyVariableName } from "../keys/envKeys.js";
import { createEnvironmentClient, type EnvironmentClient } from "../kontent/environmentClient.js";
import { KontentApiError } from "../kontent/kontentHttp.js";
import type { LocatedEnvironment, ProjectOverview } from "../projects/projectService.js";
import { createInMemoryKvStore } from "../storage/kvStore.js";
import { clientEnvId, clientProjectId, masterEnvId } from "../testing/fixtures.js";
import { createOnboardingService } from "./onboardingService.js";

const caller: Caller = { userId: "u1", email: "ada@example.com", name: "Ada", roles: [] };
const newEnvId = "77777777-7777-7777-7777-777777777777";

const located: Record<string, LocatedEnvironment> = {
  [clientEnvId]: {
    environmentId: clientEnvId,
    environmentName: "Production",
    projectId: clientProjectId,
    projectName: "Client A",
    isMasterProject: false,
  },
  [masterEnvId]: {
    environmentId: masterEnvId,
    environmentName: "Production",
    projectId: "p-master",
    projectName: "Master",
    isMasterProject: true,
  },
};

const overview: ProjectOverview = {
  masterFound: true,
  projects: [
    {
      id: clientProjectId,
      name: "Client A",
      isActive: true,
      isMasterProject: false,
      environments: [],
    },
  ],
};

const setup = (
  options: Readonly<{ client?: Partial<EnvironmentClient>; env?: Record<string, string> }> = {},
) => {
  const kv = createInMemoryKvStore();
  let tick = Date.parse("2026-11-09T10:00:00.000Z");
  const audit = createAuditLog(kv, () => {
    tick += 1000;
    return new Date(tick);
  });
  const client: EnvironmentClient = {
    clone: vi.fn(async () => await Promise.resolve(newEnvId)),
    cloningState: vi.fn(async () => await Promise.resolve("done")),
    ...options.client,
  };
  const environmentClient = vi.fn(() => client);
  const service = createOnboardingService({
    projects: {
      locate: async (id) => {
        const env = located[id];
        if (env === undefined) {
          throw new Error("unknown");
        }
        return await Promise.resolve(env);
      },
      overview: async () => await Promise.resolve(overview),
    },
    env: () => options.env ?? { [keyVariableName(clientProjectId)]: "project-key" },
    environmentClient,
    audit,
  });
  return { service, audit, client, environmentClient };
};

describe("onboarding: clone an environment", () => {
  it("clones with the project key, returns only the new ID and audits", async () => {
    const { service, audit, client, environmentClient } = setup();

    const result = await service.cloneEnvironment(caller, clientEnvId, " Develop ", false);

    expect(result).toEqual({ environmentId: newEnvId, name: "Develop" });
    expect(environmentClient).toHaveBeenCalledWith(clientEnvId, "project-key");
    expect(client.clone).toHaveBeenCalledWith("Develop", { copyContent: false });
    expect((await audit.list(1))[0]).toMatchObject({
      action: "environment.clone",
      target: clientEnvId,
      outcome: "succeeded",
      details: { newEnvironmentId: newEnvId, name: "Develop", copyContent: "no" },
    });
  });

  it("refuses master-project environments and invalid names", async () => {
    const { service, client } = setup();

    await expect(service.cloneEnvironment(caller, masterEnvId, "Dev", false)).rejects.toMatchObject(
      {
        code: "target_is_master",
      },
    );
    await expect(service.cloneEnvironment(caller, clientEnvId, "", false)).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(
      service.cloneEnvironment(caller, clientEnvId, "x".repeat(51), false),
    ).rejects.toMatchObject({ code: "invalid_name" });
    expect(client.clone).not.toHaveBeenCalled();
  });

  it("explains a missing permission and records the failure", async () => {
    const { service, audit } = setup({
      client: { clone: async () => await Promise.reject(new KontentApiError(403, "x")) },
    });

    await expect(service.cloneEnvironment(caller, clientEnvId, "Dev", false)).rejects.toMatchObject(
      {
        code: "clone_not_allowed",
      },
    );
    expect((await audit.list(1))[0]?.outcome).toBe("failed");
  });
});

describe("onboarding: cloning state", () => {
  it("reads the state of a new environment with the project key", async () => {
    const { service, environmentClient } = setup();

    expect(await service.cloningState(clientProjectId, newEnvId)).toBe("done");
    expect(environmentClient).toHaveBeenCalledWith(newEnvId, "project-key");
  });

  it("needs a key that covers the new environment", async () => {
    await expect(
      setup({ env: {} }).service.cloningState(clientProjectId, newEnvId),
    ).rejects.toMatchObject({
      code: "key_missing",
    });
  });

  it("refuses unknown projects", async () => {
    await expect(
      setup().service.cloningState("99999999-9999-9999-9999-999999999999", newEnvId),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("environment client", () => {
  it("posts a clone request and never keeps the returned key", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        await Promise.resolve(
          new Response(JSON.stringify({ id: newEnvId, management_api_key: "ey-secret" }), {
            status: 200,
          }),
        ),
    );
    const client = createEnvironmentClient({
      environmentId: clientEnvId,
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const id = await client.clone("Dev", { copyContent: true });

    expect(id).toBe(newEnvId);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`https://manage.kontent.ai/v2/projects/${clientEnvId}/clone-environment`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Dev",
      copy_data_options: { content_items_assets: true, content_item_version_history: false },
    });
  });
});
