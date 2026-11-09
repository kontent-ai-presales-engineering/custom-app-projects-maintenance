import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiClient,
  ApiError,
  getReleases,
  planRollout,
  type ReleaseMetadata,
  type RolloutPlanEntry,
  runSync,
  type SelectableEntity,
  selectableEntities,
} from "../api/client.ts";
import { runStage, type StepResult } from "../rollout/runStage.ts";
import type { DiffTarget } from "./DiffView.tsx";

type PlanState =
  | { readonly kind: "planning" }
  | { readonly kind: "planned"; readonly entry: RolloutPlanEntry }
  | { readonly kind: "error"; readonly message: string };

type RunState = "idle" | "stage1" | "stage1-done" | "stage2" | "finished" | "stopped";

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

/** Environments planned at the same time. Each plan reads the master and one client. */
const planConcurrency = 2;

type RolloutViewProps = {
  readonly client: ApiClient;
  readonly targets: ReadonlyArray<DiffTarget>;
  readonly onBack: () => void;
};

export const RolloutView = ({ client, targets, onBack }: RolloutViewProps) => {
  const [entities, setEntities] = useState<ReadonlySet<SelectableEntity>>(
    () => new Set(selectableEntities.filter((e) => e.default).map((e) => e.id)),
  );
  const [plans, setPlans] = useState<ReadonlyMap<string, PlanState>>(new Map());
  const [phrase, setPhrase] = useState("");
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [progress, setProgress] = useState<ReadonlyMap<string, StepResult | "running">>(new Map());
  // Roll out a release instead of the live master; null means live master.
  const [releases, setReleases] = useState<ReadonlyArray<ReleaseMetadata>>([]);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  useEffect(() => {
    getReleases(client).then(
      (data) => setReleases(data.releases),
      () => undefined,
    );
  }, [client]);

  const plan = useCallback(async () => {
    setPlans(new Map(targets.map((t) => [t.environmentId, { kind: "planning" }])));
    setPhrase("");
    setDestructiveConfirmed(false);
    setProgress(new Map());
    setRunState("idle");
    const queue = [...targets];
    const worker = async () => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        const id = target.environmentId;
        try {
          const entry = await planRollout(client, id, [...entities], releaseId ?? undefined);
          setPlans((current) => new Map(current).set(id, { kind: "planned", entry }));
        } catch (error) {
          setPlans((current) =>
            new Map(current).set(id, { kind: "error", message: errorMessage(error) }),
          );
        }
      }
    };
    await Promise.all(Array.from({ length: planConcurrency }, worker));
  }, [client, targets, entities, releaseId]);

  // Plan once on open; after changing entities the user clicks "Plan again".
  const plannedOnce = useRef(false);
  useEffect(() => {
    if (!plannedOnce.current) {
      plannedOnce.current = true;
      void plan();
    }
  }, [plan]);

  const planned = [...plans.values()].flatMap((p) => (p.kind === "planned" ? [p.entry] : []));
  const ready = planned.filter((entry) => entry.status === "ready");
  const stage1 = ready.filter((entry) => entry.stage === "non-production");
  const stage2 = ready.filter((entry) => entry.stage === "production");
  const destructiveCount = ready.filter((entry) => entry.destructive > 0).length;
  const stillPlanning = [...plans.values()].some((p) => p.kind === "planning");
  const expectedPhrase = `ROLLOUT ${ready.length}`;
  const confirmed =
    phrase.trim() === expectedPhrase && (destructiveCount === 0 || destructiveConfirmed);

  const syncOne = async (entry: RolloutPlanEntry): Promise<StepResult> => {
    const outcome = await runSync(client, {
      environmentId: entry.environmentId,
      entities: [...entities],
      diffHash: entry.diffHash,
      // The batch confirmation above stands in for typing each project name.
      confirmProjectName: entry.projectName,
      confirmDestructive: destructiveConfirmed,
      release: releaseId ?? undefined,
    });
    switch (outcome.status) {
      case "succeeded":
        return {
          ok: true,
          message: `${outcome.operations} changes applied, backup ${outcome.backupId}`,
        };
      case "nothing_to_sync":
        return { ok: true, message: "Already in sync" };
      case "validation_failed":
        return { ok: false, message: `data-ops refused: ${outcome.problems.join("; ")}` };
    }
  };

  const onProgress = (id: string, result: StepResult | "running") =>
    setProgress((current) => new Map(current).set(id, result));

  const runStage1 = async () => {
    setRunState("stage1");
    const outcome = await runStage(stage1, syncOne, onProgress);
    setRunState(outcome.completed ? "stage1-done" : "stopped");
  };

  const runStage2 = async () => {
    setRunState("stage2");
    const outcome = await runStage(stage2, syncOne, onProgress);
    setRunState(outcome.completed ? "finished" : "stopped");
  };

  const busy = runState === "stage1" || runState === "stage2";

  const statusCell = (target: DiffTarget) => {
    const state = plans.get(target.environmentId);
    if (state === undefined || state.kind === "planning") {
      return <span className="muted">Planning...</span>;
    }
    if (state.kind === "error") {
      return <span className="status missing">Could not plan: {state.message}</span>;
    }
    const { entry } = state;
    if (entry.status === "blocked") {
      return (
        <span className="status missing" title={entry.blocks.join("\n")}>
          Blocked, skipped ({entry.blocks.length})
        </span>
      );
    }
    if (entry.status === "in_sync") {
      return <span className="status ok">In sync, skipped</span>;
    }
    return (
      <>
        {entry.changes} changes
        {entry.destructive > 0 ? (
          <span className="status missing"> ({entry.destructive} destructive)</span>
        ) : null}
        {entry.excluded > 0 ? <span className="muted"> ({entry.excluded} excluded)</span> : null}
      </>
    );
  };

  const resultCell = (environmentId: string) => {
    const result = progress.get(environmentId);
    if (result === undefined) {
      return null;
    }
    if (result === "running") {
      return <span className="muted">Syncing...</span>;
    }
    return <span className={`status ${result.ok ? "ok" : "missing"}`}>{result.message}</span>;
  };

  const stageOf = (target: DiffTarget) => {
    const state = plans.get(target.environmentId);
    return state?.kind === "planned"
      ? state.entry.isProduction === null
        ? "Production (unknown, treated as production)"
        : state.entry.stage === "production"
          ? "Production"
          : "Non-production"
      : "";
  };

  return (
    <div>
      <div className="toolbar">
        <h2>Rollout to {targets.length} environments</h2>
        <button type="button" disabled={busy} onClick={onBack}>
          Back to drift
        </button>
      </div>

      <fieldset className="entities" disabled={busy || runState !== "idle"}>
        <legend>Entities to sync</legend>
        {releases.length > 0 ? (
          <label>
            From:{" "}
            <select
              value={releaseId ?? ""}
              onChange={(event) =>
                setReleaseId(event.target.value === "" ? null : event.target.value)
              }
            >
              <option value="">Live master</option>
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  Release {release.version}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {selectableEntities.map((entity) => (
          <label key={entity.id}>
            <input
              type="checkbox"
              checked={entities.has(entity.id)}
              onChange={() =>
                setEntities((current) => {
                  const next = new Set(current);
                  if (next.has(entity.id)) {
                    next.delete(entity.id);
                  } else {
                    next.add(entity.id);
                  }
                  return next;
                })
              }
            />
            {entity.label}
          </label>
        ))}
        <button
          type="button"
          disabled={entities.size === 0 || stillPlanning}
          onClick={() => void plan()}
        >
          Plan again
        </button>
      </fieldset>

      <table>
        <thead>
          <tr>
            <th>Sub-project</th>
            <th>Environment</th>
            <th>Stage</th>
            <th>Plan</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target) => (
            <tr key={target.environmentId}>
              <td>{target.projectName}</td>
              <td>{target.environmentName}</td>
              <td>{stageOf(target)}</td>
              <td>{statusCell(target)}</td>
              <td>{resultCell(target.environmentId)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!stillPlanning && ready.length === 0 ? (
        <p className="muted">
          Nothing to roll out: every environment is in sync, blocked or failed to plan.
        </p>
      ) : null}

      {!stillPlanning && ready.length > 0 && runState === "idle" ? (
        <section className="panel sync">
          <h3>Confirm the rollout</h3>
          <ol className="muted steps">
            <li>
              Stage 1: {stage1.length} non-production{" "}
              {stage1.length === 1 ? "environment" : "environments"}, one at a time.
            </li>
            <li>
              Stage 2: {stage2.length} production{" "}
              {stage2.length === 1 ? "environment" : "environments"}, only after stage 1 succeeded
              and you continue.
            </li>
            <li>
              Each environment is synced like a single sync: the diff must still match this plan, a
              backup is made first, data-ops validates, and it is logged. The rollout stops at the
              first failure.
            </li>
            <li>Keep this page open: closing it stops the rollout before the next environment.</li>
          </ol>
          {destructiveCount > 0 ? (
            <label className="confirm">
              <input
                type="checkbox"
                checked={destructiveConfirmed}
                onChange={(event) => setDestructiveConfirmed(event.target.checked)}
              />
              I understand that {destructiveCount} of these environments have destructive changes
              that remove content. Use Compare on the Drift tab to see the counts first.
            </label>
          ) : null}
          <label className="confirm">
            Type <strong>{expectedPhrase}</strong> to confirm this replaces typing each project
            name:
            <input
              type="text"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="danger"
            disabled={!confirmed}
            onClick={() => void (stage1.length > 0 ? runStage1() : runStage2())}
          >
            {stage1.length > 0 ? "Start stage 1 (non-production)" : "Start production"}
          </button>
        </section>
      ) : null}

      {runState === "stage1-done" ? (
        <section className="panel synced">
          <h3>Stage 1 succeeded</h3>
          {stage2.length > 0 ? (
            <>
              <p>Check the non-production environments, then continue with production.</p>
              <button type="button" className="danger" onClick={() => void runStage2()}>
                Continue to production ({stage2.length})
              </button>
            </>
          ) : (
            <p>There are no production environments in this rollout.</p>
          )}
        </section>
      ) : null}
      {runState === "finished" ? (
        <p className="status ok">Rollout finished. Run Check all on the Drift tab to confirm.</p>
      ) : null}
      {runState === "stopped" ? (
        <p className="error" role="alert">
          The rollout stopped at the first failure. Environments after it were not synced. Use
          Compare for that environment, then plan again.
        </p>
      ) : null}
    </div>
  );
};
