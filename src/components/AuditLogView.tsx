import { useCallback, useEffect, useState } from "react";
import { type ApiClient, ApiError, type AuditEntry, getAudit } from "../api/client.ts";

const actionLabel: Record<AuditEntry["action"], string> = {
  "backup.create": "Backup",
  "sync.run": "Sync",
  "backup.restore": "Restore",
  "exclusions.update": "Exclusions changed",
  "release.create": "Release created",
  "environment.clone": "Environment cloned",
};

const statusLabel: Record<AuditEntry["status"], string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  pending: "Running",
  incomplete: "Incomplete",
};

const detailLabel: Record<string, string> = {
  backupId: "Backup",
  restoredBackupId: "Restored backup",
  operations: "Changes",
  entities: "Entities",
  reason: "Reason",
  stage: "Failed at",
  error: "Error type",
  problems: "Validation problems",
  excluded: "Excluded items",
  items: "Exclusions",
  version: "Version",
  release: "Release",
  releaseId: "Release ID",
  newEnvironmentId: "New environment",
  name: "Name",
  copyContent: "Content copied",
};

const Details = ({ details }: { readonly details: AuditEntry["details"] }) =>
  details === null ? null : (
    <ul className="details">
      {Object.entries(details).map(([key, value]) => (
        <li key={key}>
          <span className="muted">{detailLabel[key] ?? key}:</span> <code>{String(value)}</code>
        </li>
      ))}
    </ul>
  );

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly entries: ReadonlyArray<AuditEntry>;
      readonly nextCursor: string | null;
    };

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

export const AuditLogView = ({ client }: { readonly client: ApiClient }) => {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    getAudit(client).then(
      (page) => setState({ kind: "ready", entries: page.entries, nextCursor: page.nextCursor }),
      (error: unknown) => setState({ kind: "error", message: errorMessage(error) }),
    );
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = () => {
    if (state.kind !== "ready" || state.nextCursor === null) {
      return;
    }
    setLoadingMore(true);
    getAudit(client, state.nextCursor).then(
      (page) => {
        setLoadingMore(false);
        setState({
          kind: "ready",
          entries: [...state.entries, ...page.entries],
          nextCursor: page.nextCursor,
        });
      },
      (error: unknown) => {
        setLoadingMore(false);
        setState({ kind: "error", message: errorMessage(error) });
      },
    );
  };

  return (
    <div>
      <div className="toolbar">
        <h2>Audit log</h2>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Every backup, sync and restore, most recent first. Entries are written before an action
        starts. "Incomplete" means it never recorded an outcome, usually because the function timed
        out.
      </p>

      {state.kind === "loading" ? <p>Loading...</p> : null}
      {state.kind === "error" ? (
        <p className="error" role="alert">
          Could not load the audit log: {state.message}
        </p>
      ) : null}
      {state.kind === "ready" && state.entries.length === 0 ? (
        <p className="muted">No entries yet.</p>
      ) : null}
      {state.kind === "ready" && state.entries.length > 0 ? (
        <>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {state.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.at).toLocaleString()}</td>
                  <td>{entry.actor.email}</td>
                  <td>{actionLabel[entry.action]}</td>
                  <td>
                    {entry.targetName === null ? (
                      <code>{entry.target ?? "-"}</code>
                    ) : (
                      <>
                        {entry.targetName.projectName} / {entry.targetName.environmentName}
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`badge outcome-${entry.status}`}>
                      {statusLabel[entry.status]}
                    </span>
                  </td>
                  <td>
                    <Details details={entry.details} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.nextCursor === null ? null : (
            <div className="toolbar">
              <button type="button" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};
