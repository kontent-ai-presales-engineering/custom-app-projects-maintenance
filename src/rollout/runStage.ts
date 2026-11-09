/**
 * Runs the syncs of one rollout stage one at a time and stops at the first one that
 * does not succeed. Pure logic without React, so it can be tested on its own.
 */
export type StageEntry = Readonly<{ environmentId: string }>;

export type StepResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; message: string }>;

export type StageOutcome = Readonly<{
  /** True when every entry succeeded. */
  completed: boolean;
  /** Results in order. Entries after a failure are not attempted and not listed. */
  results: ReadonlyArray<Readonly<{ environmentId: string } & StepResult>>;
}>;

export const runStage = async <T extends StageEntry>(
  entries: ReadonlyArray<T>,
  syncOne: (entry: T) => Promise<StepResult>,
  onProgress: (environmentId: string, result: StepResult | "running") => void = () => undefined,
): Promise<StageOutcome> => {
  const results: Array<Readonly<{ environmentId: string } & StepResult>> = [];
  for (const entry of entries) {
    onProgress(entry.environmentId, "running");
    let result: StepResult;
    try {
      result = await syncOne(entry);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : "Sync failed" };
    }
    results.push({ environmentId: entry.environmentId, ...result });
    onProgress(entry.environmentId, result);
    if (!result.ok) {
      return { completed: false, results };
    }
  }
  return { completed: true, results };
};
