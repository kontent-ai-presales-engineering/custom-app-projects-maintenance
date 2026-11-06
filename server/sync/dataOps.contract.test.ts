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
      { sourceEnvironmentId: masterEnvId, targetEnvironmentId: clientEnvId },
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
