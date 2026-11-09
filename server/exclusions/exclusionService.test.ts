import { describe, expect, it } from "vitest";
import type { Caller } from "../access/accessGuard.js";
import { createAuditLog } from "../audit/auditLog.js";
import type { ProjectOverview } from "../projects/projectService.js";
import { createInMemoryKvStore } from "../storage/kvStore.js";
import { clientProjectId } from "../testing/fixtures.js";
import { createExclusionService } from "./exclusionService.js";

const caller: Caller = { userId: "u1", email: "ada@example.com", name: "Ada", roles: [] };
const masterProjectId = "66666666-6666-6666-6666-666666666666";

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
    {
      id: masterProjectId,
      name: "Master",
      isActive: true,
      isMasterProject: true,
      environments: [],
    },
  ],
};

const setup = () => {
  const kv = createInMemoryKvStore();
  let tick = Date.parse("2026-11-09T10:00:00.000Z");
  const clock = () => {
    tick += 1000;
    return new Date(tick);
  };
  const audit = createAuditLog(kv, clock);
  const service = createExclusionService({
    projects: { overview: async () => await Promise.resolve(overview) },
    kv,
    audit,
    now: clock,
  });
  return { service, audit };
};

describe("exclusion service", () => {
  it("returns no exclusions for a client that has none", async () => {
    expect(await setup().service.get(clientProjectId)).toEqual({
      projectId: clientProjectId,
      items: {},
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("stores normalised exclusions and audits the change", async () => {
    const { service, audit } = setup();

    const saved = await service.set(caller, clientProjectId.toUpperCase(), {
      contentTypes: ["page", "article", "page"],
      taxonomies: [],
    });

    expect(saved.items).toEqual({ contentTypes: ["article", "page"] });
    expect((await service.get(clientProjectId)).items).toEqual({
      contentTypes: ["article", "page"],
    });
    expect((await audit.list(1))[0]).toMatchObject({
      action: "exclusions.update",
      target: clientProjectId,
      outcome: "succeeded",
      details: { excluded: 2, items: "contentTypes:article|page" },
    });
  });

  it("refuses the master project and unknown projects", async () => {
    const { service } = setup();

    await expect(service.set(caller, masterProjectId, {})).rejects.toMatchObject({
      status: 403,
      code: "target_is_master",
    });
    await expect(
      service.set(caller, "99999999-9999-9999-9999-999999999999", {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.get("not-a-guid")).rejects.toMatchObject({ status: 400 });
  });
});
