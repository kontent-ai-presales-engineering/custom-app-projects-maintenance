import { useCallback, useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  createRelease,
  getReleases,
  type ReleasesData,
} from "../api/client.ts";

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

/** Suggests the next "vN" after the highest existing one. */
const nextVersion = (data: ReleasesData | null) => {
  const numbers = (data?.releases ?? []).flatMap((release) => {
    const match = /^v(\d+)$/i.exec(release.version);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
  return `v${numbers.length === 0 ? 1 : Math.max(...numbers) + 1}`;
};

export const ReleasesView = ({ client }: { readonly client: ApiClient }) => {
  const [data, setData] = useState<ReleasesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    getReleases(client).then(
      (loaded) => {
        setData(loaded);
        setVersion((current) => (current === "" ? nextVersion(loaded) : current));
      },
      (error: unknown) => setLoadError(errorMessage(error)),
    );
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const create = () => {
    setCreating(true);
    setMessage(null);
    createRelease(client, version, notes).then(
      (release) => {
        setCreating(false);
        setMessage(`Release ${release.version} created.`);
        setNotes("");
        setVersion("");
        load();
      },
      (error: unknown) => {
        setCreating(false);
        setMessage(errorMessage(error));
      },
    );
  };

  return (
    <div>
      <h2>Master releases</h2>
      <p className="muted">
        A release is a frozen copy of the master's content model with a version and notes. Compare,
        sync and rollouts can use a release instead of the live master, so edits made in the master
        afterwards do not reach sub-projects until you release them.
      </p>

      <section className="panel">
        <h3>Create a release from the current master</h3>
        <label className="confirm">
          Version
          <input
            type="text"
            value={version}
            disabled={creating}
            onChange={(event) => setVersion(event.target.value)}
            maxLength={40}
          />
        </label>
        <label className="confirm">
          Changelog notes
          <textarea
            className="notes"
            value={notes}
            disabled={creating}
            onChange={(event) => setNotes(event.target.value)}
            rows={4}
            maxLength={5000}
          />
        </label>
        <div className="toolbar">
          <button type="button" disabled={creating || version.trim() === ""} onClick={create}>
            {creating ? "Creating..." : "Create release"}
          </button>
          {message === null ? null : <output className="status">{message}</output>}
        </div>
      </section>

      {loadError === null ? null : (
        <p className="error" role="alert">
          Could not load releases: {loadError}
        </p>
      )}
      {data === null && loadError === null ? <p>Loading...</p> : null}
      {data !== null && data.releases.length === 0 ? (
        <p className="muted">No releases yet.</p>
      ) : null}
      {data !== null && data.releases.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Created</th>
              <th>Notes</th>
              <th>Contents</th>
              <th>Environments on it</th>
            </tr>
          </thead>
          <tbody>
            {data.releases.map((release) => (
              <tr key={release.id}>
                <td>
                  <strong>{release.version}</strong>
                </td>
                <td>
                  {new Date(release.createdAt).toLocaleString()}
                  <div className="muted">{release.createdBy.email}</div>
                </td>
                <td className="notes-cell">{release.notes === "" ? "-" : release.notes}</td>
                <td className="muted">
                  {Object.entries(release.counts)
                    .map(([file, count]) => `${file.replace(".json", "")}: ${count}`)
                    .join(", ")}
                </td>
                <td>
                  {
                    Object.values(data.clientReleases).filter((c) => c.releaseId === release.id)
                      .length
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
};
