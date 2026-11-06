/**
 * Contract tests against the real @kontent-ai/data-ops package. They fail when an
 * upgrade moves or changes the internal entry points this app relies on.
 */
import { describe, expect, it } from "vitest";
import { addInto, diffModel, remove } from "../testing/diffModel.js";
import { clientEnvId, masterEnvId } from "../testing/fixtures.js";
import { dataOpsDiffEngine } from "./dataOps.js";

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
