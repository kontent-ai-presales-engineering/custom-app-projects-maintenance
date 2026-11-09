import { describe, expect, it, vi } from "vitest";
import { keyVariableName } from "../keys/envKeys.js";
import type { ManagementClient, ModelType } from "../kontent/managementClient.js";
import type { LocatedEnvironment } from "../projects/projectService.js";
import { diffModel, remove } from "../testing/diffModel.js";
import { clientEnvId, clientProjectId, masterEnvId } from "../testing/fixtures.js";
import type { DiffEngine, DiffModel } from "./dataOps.js";
import { createDiffService } from "./diffService.js";

const located: Record<string, LocatedEnvironment> = {
  [masterEnvId]: {
    environmentId: masterEnvId,
    environmentName: "Production",
    projectId: "p-master",
    projectName: "Master",
    isMasterProject: true,
  },
  [clientEnvId]: {
    environmentId: clientEnvId,
    environmentName: "Production",
    projectId: clientProjectId,
    projectName: "Client A",
    isMasterProject: false,
  },
};

const article: ModelType = {
  id: "t-article",
  codename: "article",
  elements: [{ id: "e-summary", codename: "summary", type: "text" }],
};

const keys = {
  [keyVariableName(masterEnvId)]: "master-key",
  [keyVariableName(clientEnvId)]: "client-key",
};

const management: ManagementClient = {
  getEnvironmentInfo: async () => Promise.reject(new Error("unused")),
  checkContentModelAccess: async () => Promise.resolve(),
  listTypes: async () => Promise.resolve([article]),
  listSnippets: async () => Promise.resolve([]),
  listTaxonomies: async () => Promise.resolve([]),
  listLanguages: async () => Promise.resolve([{ id: "l-en", codename: "en", is_active: true }]),
  listVariantsOfType: async () =>
    Promise.resolve([{ elements: [{ element: { id: "e-summary" }, value: "text" }] }]),
  isUsedAsComponent: async () => Promise.resolve(false),
  countItems: async () => Promise.resolve(0),
};

const setup = (
  options: Readonly<{ env?: Record<string, string>; model?: DiffModel; diffError?: Error }> = {},
) => {
  const engine: DiffEngine = {
    diff: vi.fn(async () =>
      options.diffError === undefined
        ? Promise.resolve(options.model ?? diffModel())
        : Promise.reject(options.diffError),
    ),
    renderReport: vi.fn(() => "<html>report</html>"),
  };
  const log = vi.fn();
  const managementClient = vi.fn(() => management);
  const deliveryClient = vi.fn(() => ({ publishedItems: async () => Promise.resolve([]) }));
  const service = createDiffService({
    config: { masterEnvironmentId: masterEnvId, clientPrefix: "client_" },
    backups: { get: async () => Promise.reject(new Error("no backups in this test")) },
    releases: {
      get: async () => await Promise.reject(new Error("no releases in this test")),
    },
    exclusions: {
      get: async (projectId) =>
        await Promise.resolve({ projectId, items: {}, updatedAt: null, updatedBy: null }),
    },
    projects: {
      locate: async (id) => {
        const env = located[id];
        if (env === undefined) {
          throw new Error("unknown");
        }
        return await Promise.resolve(env);
      },
    },
    env: () => options.env ?? keys,
    engine,
    managementClient,
    deliveryClient,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    log,
  });
  return { service, engine, log, managementClient, deliveryClient };
};

describe("diff service", () => {
  it("diffs master against the client, filters client items, and counts impact", async () => {
    const model = diffModel({
      contentTypes: {
        updated: {
          article: [remove("/elements/codename:summary"), remove("/elements/codename:client_note")],
        },
      },
    });
    const { service, engine, managementClient } = setup({ model });

    const result = await service.diff(clientEnvId, { entities: ["contentTypes"] });

    expect(engine.diff).toHaveBeenCalledWith(
      { kind: "environment", environment: { environmentId: masterEnvId, apiKey: "master-key" } },
      { environmentId: clientEnvId, apiKey: "client-key" },
      ["contentTypes"],
    );
    expect(managementClient).toHaveBeenCalledWith(clientEnvId, "client-key");
    expect(result.target).toEqual({
      environmentId: clientEnvId,
      environmentName: "Production",
      projectId: clientProjectId,
      projectName: "Client A",
    });
    expect(result.changes[0]?.operations).toEqual(["remove /elements/codename:summary"]);
    expect(result.keptClientItems).toHaveLength(1);
    expect(result.destructive[0]?.impact).toEqual({ latest: 1, published: 0, unknownReasons: [] });
    expect(result.inSync).toBe(false);
    expect(result.reportHtml).toBe("<html>report</html>");
  });

  it("renders the report from the filtered diff", async () => {
    const model = diffModel({
      contentTypes: { updated: { article: [remove("/elements/codename:client_note")] } },
    });
    const { service, engine } = setup({ model });
    await service.diff(clientEnvId, { entities: ["contentTypes"] });

    const reported = vi.mocked(engine.renderReport).mock.calls[0]?.[0];
    expect(reported?.contentTypes.updated.size).toBe(0);
  });

  it("reports in sync when there are no changes", async () => {
    expect((await setup().service.diff(clientEnvId, { entities: ["contentTypes"] })).inSync).toBe(
      true,
    );
  });

  it("refuses an environment of the master project as target", async () => {
    const { service, engine } = setup();

    await expect(service.diff(masterEnvId, { entities: ["contentTypes"] })).rejects.toMatchObject({
      status: 403,
      code: "target_is_master",
    });
    expect(engine.diff).not.toHaveBeenCalled();
  });

  it("asks for a key when the target has none", async () => {
    const { service } = setup({ env: { [keyVariableName(masterEnvId)]: "master-key" } });

    await expect(service.diff(clientEnvId, { entities: ["contentTypes"] })).rejects.toMatchObject({
      status: 409,
      code: "key_missing",
    });
  });

  it("hides data-ops error details from the response", async () => {
    const { service, log } = setup({ diffError: new Error("Request failed: Bearer client-key") });

    const error = await service
      .diff(clientEnvId, { entities: ["contentTypes"] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: "diff_failed" });
    expect((error as Error).message).not.toContain("client-key");
    expect(log).toHaveBeenCalled();
  });
});
