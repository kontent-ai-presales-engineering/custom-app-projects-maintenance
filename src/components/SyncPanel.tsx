import { useState } from "react";
import {
  type ApiClient,
  ApiError,
  type DiffResult,
  runSync,
  type SyncOutcome,
} from "../api/client.ts";

type State =
  | { readonly kind: "ready" }
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly outcome: SyncOutcome }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

type SyncPanelProps = {
  readonly client: ApiClient;
  readonly result: DiffResult;
  /** Called after a sync attempt that may have changed the client (to refresh views). */
  readonly onFinished: () => void;
};

export const SyncPanel = ({ client, result, onFinished }: SyncPanelProps) => {
  const [typedName, setTypedName] = useState("");
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(false);
  const [state, setState] = useState<State>({ kind: "ready" });

  const projectName = result.target.projectName;
  const restore = result.source.kind === "backup" ? result.source : null;
  const verb = restore === null ? "Sync" : "Restore";
  const releaseLabel =
    result.source.kind === "release" ? ` (release ${result.source.version})` : "";
  const destructive = result.destructive.length;
  const unknown = result.destructive.filter(
    (change) => change.impact.latest === null || change.impact.published === null,
  ).length;
  const nameMatches = typedName.trim() === projectName;
  const canSync =
    state.kind !== "running" && nameMatches && (destructive === 0 || destructiveConfirmed);

  const run = () => {
    setState({ kind: "running" });
    runSync(client, {
      environmentId: result.target.environmentId,
      entities: result.entities,
      diffHash: result.diffHash,
      confirmProjectName: typedName,
      confirmDestructive: destructiveConfirmed,
      restoreFrom: restore?.backupId,
      release: result.source.kind === "release" ? result.source.releaseId : undefined,
      items: result.selection?.items,
    }).then(
      (outcome) => {
        setState({ kind: "done", outcome });
        onFinished();
      },
      (error: unknown) => {
        setState({
          kind: "error",
          code: error instanceof ApiError ? error.code : "error",
          message: error instanceof Error ? error.message : "Something went wrong",
        });
        if (error instanceof ApiError && error.code === "sync_failed") {
          onFinished();
        }
      },
    );
  };

  if (state.kind === "done" && state.outcome.status === "succeeded") {
    return (
      <section className="panel synced">
        <h3>{restore === null ? "Synced" : "Restored"}</h3>
        <p>
          {state.outcome.operations} changes were applied to {state.outcome.projectName} /{" "}
          {state.outcome.environmentName}. A backup was made first ({state.outcome.backupId}).
        </p>
        <p className="muted">Compare again to confirm the sub-project is now in sync.</p>
      </section>
    );
  }

  return (
    <section className="panel sync">
      <h3>
        {verb} {projectName}
        {releaseLabel}
        {restore === null
          ? null
          : ` from the backup of ${new Date(restore.createdAt).toLocaleString()}`}
      </h3>
      <ol className="muted steps">
        <li>The diff is recomputed and must be identical to the one shown above.</li>
        <li>The sub-project's current content model is backed up first.</li>
        <li>data-ops validates the changes, then applies them to this environment only.</li>
      </ol>

      {destructive > 0 ? (
        <label className="confirm">
          <input
            type="checkbox"
            checked={destructiveConfirmed}
            disabled={state.kind === "running"}
            onChange={(event) => setDestructiveConfirmed(event.target.checked)}
          />
          I understand that {destructive} destructive {destructive === 1 ? "change" : "changes"}{" "}
          will remove content in the sub-project
          {unknown > 0 ? `, and that the impact of ${unknown} of them is unknown` : ""}.
        </label>
      ) : null}

      <label className="confirm">
        Type the project name <strong>{projectName}</strong> to confirm:
        <input
          type="text"
          value={typedName}
          disabled={state.kind === "running"}
          onChange={(event) => setTypedName(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="toolbar">
        <button type="button" className="danger" disabled={!canSync} onClick={run}>
          {state.kind === "running"
            ? `${verb === "Sync" ? "Syncing" : "Restoring"}...`
            : restore === null
              ? `Sync to ${projectName}`
              : `Restore ${projectName}`}
        </button>
        {state.kind === "running" ? (
          <span className="muted">
            Backing up, validating and applying. This can take several minutes; keep this page open.
          </span>
        ) : null}
      </div>

      {state.kind === "done" && state.outcome.status === "nothing_to_sync" ? (
        <output className="status ok">
          Nothing to sync: the sub-project is already up to date.
        </output>
      ) : null}
      {state.kind === "done" && state.outcome.status === "validation_failed" ? (
        <div className="error" role="alert">
          <p>
            data-ops refused the {verb.toLowerCase()}. Nothing was changed (a backup was made:{" "}
            {state.outcome.backupId}).
          </p>
          <ul>
            {state.outcome.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <p className="error" role="alert">
          {state.message}
          {state.code === "diff_changed" ? " Use Compare above to load the current diff." : ""}
        </p>
      ) : null}
    </section>
  );
};
