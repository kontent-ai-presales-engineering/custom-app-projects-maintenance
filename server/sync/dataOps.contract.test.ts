/**
 * Contract tests against the real @kontent-ai/data-ops package. They fail when an
 * upgrade moves or changes the internal entry points this app relies on.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addInto, diffModel, remove } from "../testing/diffModel.js";
import { clientEnvId, masterEnvId } from "../testing/fixtures.js";
import { createDataOpsSnapshotter, dataOpsDiffEngine } from "./dataOps.js";

describe("data-ops contract (2.8.1 with exports patch)", () => {
  it("exposes the internal entry points used for diff and sync", async () => {
    const diff = await import("@kontent-ai/data-ops/internal/diff");
    const sync = await import("@kontent-ai/data-ops/internal/sync");
    const syncRun = await import("@kontent-ai/data-ops/internal/sync-run");
    const report = await import("@kontent-ai/data-ops/internal/report");
    const patchOperation = await import("@kontent-ai/data-ops/internal/patch-operation");

    expect(typeof diff.syncDiffInternal).toBe("function");
    expect(typeof sync.sync).toBe("function");
    expect(typeof syncRun.validateTargetEnvironment).toBe("function");
    expect(typeof report.renderDiffReport).toBe("function");
    expect(typeof patchOperation.getTargetCodename).toBe("function");
  });

  it("reads codenames from patch paths the way this app assumes", async () => {
    const { getTargetCodename } = await import("@kontent-ai/data-ops/internal/patch-operation");

    expect(getTargetCodename(remove("/elements/codename:summary"))).toBe("summary");
    expect(getTargetCodename(remove("/elements/codename:color/options/codename:red"))).toBe("red");
  });

  it("renders the HTML report from a filtered diff model", () => {
    const html = dataOpsDiffEngine.renderReport(
      diffModel({
        contentTypes: {
          updated: {
            article: [
              remove("/elements/codename:summary"),
              addInto("/elements", { codename: "subtitle", type: "text", name: "Subtitle" }),
            ],
          },
        },
      }),
      { source: masterEnvId, sourceIsEnvironment: true, targetEnvironmentId: clientEnvId },
      ["contentTypes"],
    );

    expect(html).toContain("<html");
    expect(html).toContain(clientEnvId);
    expect(html).toContain("article");
  });
});

describe("snapshotter", () => {
  it("reads the files data-ops writes and removes the temporary folder", async () => {
    let usedFolder = "";

    const snapshotter = createDataOpsSnapshotter(async (params) => {
      usedFolder = params.folderName ?? "";
      expect(Object.keys(params.entities).sort()).toEqual([
        "assetFolders",
        "collections",
        "contentTypeSnippets",
        "contentTypes",
        "languages",
        "spaces",
        "taxonomies",
        "workflows",
      ]);
      await writeFile(join(usedFolder, "contentTypes.json"), '[{"codename":"article"}]');
      await writeFile(join(usedFolder, "metadata.json"), '{"generatedWithVersion":"2.8.1"}');
      await writeFile(join(usedFolder, "notes.txt"), "ignored");
    });

    const files = await snapshotter.snapshot({ environmentId: clientEnvId, apiKey: "k" });

    expect(files).toEqual({
      "contentTypes.json": [{ codename: "article" }],
      "metadata.json": { generatedWithVersion: "2.8.1" },
    });
    expect(existsSync(usedFolder)).toBe(false);
  });

  it("removes the temporary folder when data-ops fails", async () => {
    let usedFolder = "";

    const snapshotter = createDataOpsSnapshotter(async (params) => {
      usedFolder = params.folderName ?? "";
      await Promise.reject(new Error("401"));
    });

    await expect(snapshotter.snapshot({ environmentId: clientEnvId, apiKey: "k" })).rejects.toThrow(
      "401",
    );
    expect(existsSync(usedFolder)).toBe(false);
  });
});

describe("diff hashing and entity picking", () => {
  it("hashes the same diff the same way regardless of Map and Set order", async () => {
    const { hashDiff } = await import("./dataOps.js");
    const ctx = {
      sourceEnvironmentId: masterEnvId,
      targetEnvironmentId: clientEnvId,
      entities: ["contentTypes"] as const,
    };
    const a = diffModel({
      contentTypes: { updated: { a: [remove("/x")], b: [remove("/y")] }, deleted: ["p", "q"] },
    });
    const b = diffModel({
      contentTypes: { updated: { b: [remove("/y")], a: [remove("/x")] }, deleted: ["q", "p"] },
    });

    expect(hashDiff(a, ctx)).toBe(hashDiff(b, ctx));
    expect(hashDiff(a, ctx)).not.toBe(hashDiff(diffModel(), ctx));
    expect(hashDiff(a, ctx)).not.toBe(hashDiff(a, { ...ctx, targetEnvironmentId: masterEnvId }));
  });

  it("keeps only the chosen entities", async () => {
    const { pickEntities } = await import("./dataOps.js");
    const model = diffModel({
      contentTypes: { deleted: ["old"] },
      taxonomyGroups: { deleted: ["tags"] },
      collections: [remove("/codename:c")],
    });

    const picked = pickEntities(model, ["taxonomies"]);

    expect([...picked.taxonomyGroups.deleted]).toEqual(["tags"]);
    expect(picked.contentTypes.deleted.size).toBe(0);
    expect(picked.collections).toEqual([]);
  });

  it("exposes data-ops' own Management client factory", async () => {
    const { createClient } = await import("@kontent-ai/data-ops/internal/client");

    expect(typeof createClient).toBe("function");
  });
});

describe("snapshot folder for restore", () => {
  it("writes only data-ops snapshot files and removes the folder afterwards", async () => {
    const { withSnapshotFolder } = await import("./dataOps.js");
    const { readdirSync } = await import("node:fs");
    let folder = "";

    const names = await withSnapshotFolder(
      {
        "contentTypes.json": [{ codename: "article" }],
        "metadata.json": {},
        "../escape.json": [],
        "notes.txt": "x",
      },
      async (path) => {
        folder = path;
        return await Promise.resolve(readdirSync(path).sort());
      },
    );

    expect(names).toEqual(["contentTypes.json", "metadata.json"]);
    expect(existsSync(folder)).toBe(false);
  });
});
