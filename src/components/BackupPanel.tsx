import { useCallback, useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type BackupMetadata,
  createBackup,
  downloadBackup,
  listBackups,
} from "../api/client.ts";

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly backups: ReadonlyArray<BackupMetadata> };

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

const summarise = (counts: BackupMetadata["counts"]) =>
  Object.entries(counts)
    .map(([file, count]) => `${file.replace(".json", "")}: ${count}`)
    .join(", ");

type BackupPanelProps = {
  readonly client: ApiClient;
  readonly environmentId: string;
  readonly onRestore: (backup: BackupMetadata) => void;
};

const reasonLabel: Record<BackupMetadata["reason"], string> = {
  manual: "Manual",
  "pre-sync": "Before sync",
  "pre-restore": "Before restore",
};

export const BackupPanel = ({ client, environmentId, onRestore }: BackupPanelProps) => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setList({ kind: "loading" });
    listBackups(client, environmentId).then(
      (backups) => setList({ kind: "ready", backups }),
      (error: unknown) => setList({ kind: "error", message: errorMessage(error) }),
    );
  }, [client, environmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const backUpNow = () => {
    setBusy(true);
    setMessage(null);
    createBackup(client, environmentId).then(
      (backup) => {
        setBusy(false);
        setMessage(`Backup made at ${new Date(backup.createdAt).toLocaleString()}.`);
        load();
      },
      (error: unknown) => {
        setBusy(false);
        setMessage(errorMessage(error));
      },
    );
  };

  const download = (backup: BackupMetadata) => {
    downloadBackup(client, backup).catch((error: unknown) => setMessage(errorMessage(error)));
  };

  return (
    <section className="panel">
      <div className="toolbar">
        <h3>Backups of this environment</h3>
        <button type="button" disabled={busy} onClick={backUpNow}>
          {busy ? "Backing up..." : "Back up now"}
        </button>
      </div>
      <p className="muted">
        A backup is a snapshot of the content model (types, snippets, taxonomies, collections,
        spaces, languages, workflows, asset folders), not the content. A backup is also made
        automatically before every sync.
      </p>
      {message === null ? null : <output className="status">{message}</output>}
      {list.kind === "loading" ? <p>Loading backups...</p> : null}
      {list.kind === "error" ? (
        <p className="error" role="alert">
          Could not load backups: {list.message}
        </p>
      ) : null}
      {list.kind === "ready" && list.backups.length === 0 ? (
        <p className="muted">No backups yet.</p>
      ) : null}
      {list.kind === "ready" && list.backups.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Made</th>
              <th>By</th>
              <th>Reason</th>
              <th>Contents</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.backups.map((backup) => (
              <tr key={backup.id}>
                <td>{new Date(backup.createdAt).toLocaleString()}</td>
                <td>{backup.createdBy.email}</td>
                <td>{reasonLabel[backup.reason]}</td>
                <td className="muted">{summarise(backup.counts)}</td>
                <td>
                  <button type="button" onClick={() => download(backup)}>
                    Download
                  </button>
                  <button type="button" onClick={() => onRestore(backup)}>
                    Restore...
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
};
