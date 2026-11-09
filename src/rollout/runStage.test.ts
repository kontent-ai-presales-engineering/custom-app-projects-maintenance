import { describe, expect, it, vi } from "vitest";
import { runStage, type StepResult } from "./runStage.ts";

const entries = [{ environmentId: "a" }, { environmentId: "b" }, { environmentId: "c" }];

describe("runStage", () => {
  it("syncs every entry in order when all succeed", async () => {
    const order: string[] = [];
    const outcome = await runStage(entries, async (entry) => {
      order.push(entry.environmentId);
      return await Promise.resolve<StepResult>({ ok: true, message: "done" });
    });

    expect(order).toEqual(["a", "b", "c"]);
    expect(outcome.completed).toBe(true);
    expect(outcome.results).toHaveLength(3);
  });

  it("stops at the first failure and does not attempt the rest", async () => {
    const syncOne = vi.fn(
      async (entry: { environmentId: string }) =>
        await Promise.resolve<StepResult>(
          entry.environmentId === "b"
            ? { ok: false, message: "diff changed" }
            : { ok: true, message: "ok" },
        ),
    );

    const outcome = await runStage(entries, syncOne);

    expect(outcome.completed).toBe(false);
    expect(outcome.results.map((r) => r.environmentId)).toEqual(["a", "b"]);
    expect(syncOne).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown error as a failure", async () => {
    const outcome = await runStage(entries, async () => await Promise.reject(new Error("network")));

    expect(outcome).toEqual({
      completed: false,
      results: [{ environmentId: "a", ok: false, message: "network" }],
    });
  });

  it("reports progress before and after each entry", async () => {
    const progress: Array<[string, unknown]> = [];
    await runStage(
      entries.slice(0, 1),
      async () => await Promise.resolve<StepResult>({ ok: true, message: "ok" }),
      (id, result) => progress.push([id, result]),
    );

    expect(progress).toEqual([
      ["a", "running"],
      ["a", { ok: true, message: "ok" }],
    ]);
  });
});
