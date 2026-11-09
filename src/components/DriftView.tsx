import { useCallback, useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  checkDrift,
  type DriftSummary,
  getDrift,
  getProjects,
  getReleases,
  type ProjectOverviewData,
  type ReleasesData,
} from "../api/client.ts";
import type { DiffTarget } from "./DiffView.tsx";

type Row = Readonly<{
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  hasKey: boolean;
  summary: DriftSummary | undefined;
}>;

const statusText: Record<DriftSummary["status"], string> = {
  in_sync: "In sync",
  drift: "Drift",
  blocked: "Blocked",
  error: "Check failed",
};

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

/** Client environments of the subscription (master project excluded), with their latest check. */
const rowsFrom = (
  overview: ProjectOverviewData,
  summaries: ReadonlyMap<string, DriftSummary>,
): ReadonlyArray<Row> =>
  overview.projects
    .filter((project) => !project.isMasterProject)
    .flatMap((project) =>
      project.environments.map((environment) => ({
        environmentId: environment.id,
        environmentName: environment.name,
        projectId: project.id,
        projectName: project.name,
        hasKey: environment.key.configured,
        summary: summaries.get(environment.id.toLowerCase()),
      })),
    );

/** What the environment was last synced from, as recorded after a sync. */
const syncedFrom = (clientReleases: ReleasesData["clientReleases"], environmentId: string) => {
  const synced = clientReleases[environmentId.toLowerCase()];
  if (synced === undefined) {
    return "-";
  }
  return synced.version === null ? "Live master" : `Release ${synced.version}`;
};

/** How many checks run at the same time. Each one reads the master and one client. */
const concurrency = 2;

type DriftViewProps = {
  readonly client: ApiClient;
  readonly onCompare: (target: DiffTarget) => void;
  readonly onRollout: (targets: ReadonlyArray<DiffTarget>) => void;
};

export const DriftView = ({ client, onCompare, onRollout }: DriftViewProps) => {
  // Environments ticked for a rollout.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [overview, setOverview] = useState<ProjectOverviewData | null>(null);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, DriftSummary>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clientReleases, setClientReleases] = useState<ReleasesData["clientReleases"]>({});
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [checkErrors, setCheckErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([
      getProjects(client),
      getDrift(client),
      getReleases(client).catch(() => ({ releases: [], clientReleases: {} })),
    ]).then(
      ([projects, drift, releaseData]) => {
        setClientReleases(releaseData.clientReleases);
        setOverview(projects);
        setSummaries(new Map(drift.map((summary) => [summary.environmentId, summary])));
      },
      (error: unknown) => setLoadError(errorMessage(error)),
    );
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const checkOne = async (environmentId: string) => {
    setRunning((current) => new Set(current).add(environmentId));
    try {
      const summary = await checkDrift(client, environmentId);
      setSummaries((current) => new Map(current).set(summary.environmentId, summary));
      setCheckErrors((current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
    } catch (error) {
      setCheckErrors((current) => new Map(current).set(environmentId, errorMessage(error)));
    } finally {
      setRunning((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
    }
  };

  const checkAll = async (rows: ReadonlyArray<Row>) => {
    const queue = rows.filter((row) => row.hasKey).map((row) => row.environmentId);
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        await checkOne(id);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  };

  if (loadError !== null) {
    return (
      <div>
        <p className="error" role="alert">
          Could not load the drift overview: {loadError}
        </p>
        <button type="button" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (overview === null) {
    return <p>Loading...</p>;
  }

  const rows = rowsFrom(overview, summaries);
  const checkable = rows.filter((row) => row.hasKey).length;

  return (
    <div>
      <div className="toolbar">
        <h2>Drift across sub-projects</h2>
        <button
          type="button"
          disabled={selected.size === 0 || running.size > 0}
          onClick={() =>
            onRollout(
              rows
                .filter((row) => selected.has(row.environmentId))
                .map((row) => ({
                  environmentId: row.environmentId,
                  environmentName: row.environmentName,
                  projectName: row.projectName,
                  projectId: row.projectId,
                })),
            )
          }
        >
          Plan rollout ({selected.size})
        </button>
        <button
          type="button"
          disabled={running.size > 0 || checkable === 0}
          onClick={() => void checkAll(rows)}
        >
          {running.size > 0 ? `Checking (${running.size} running)...` : `Check all (${checkable})`}
        </button>
      </div>
      <p className="muted">
        Compares each sub-project environment with the master for content types, snippets and
        taxonomies, respecting exclusions and project-specific items. Read-only. Results are stored,
        so everyone sees the latest check.
      </p>

      <table>
        <thead>
          <tr>
            <th />
            <th>Sub-project</th>
            <th>Environment</th>
            <th>Synced from</th>
            <th>Status</th>
            <th>Changes</th>
            <th>Last checked</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const summary = row.summary;
            const isRunning = running.has(row.environmentId);
            const checkError = checkErrors.get(row.environmentId);
            return (
              <tr key={row.environmentId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Include ${row.projectName} ${row.environmentName} in a rollout`}
                    disabled={!row.hasKey}
                    checked={selected.has(row.environmentId)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(row.environmentId)) {
                          next.delete(row.environmentId);
                        } else {
                          next.add(row.environmentId);
                        }
                        return next;
                      })
                    }
                  />
                </td>
                <td>{row.projectName}</td>
                <td>{row.environmentName}</td>
                <td className="muted">{syncedFrom(clientReleases, row.environmentId)}</td>
                <td>
                  {!row.hasKey ? (
                    <span className="muted">No key</span>
                  ) : summary === undefined ? (
                    <span className="muted">Not checked</span>
                  ) : (
                    <span className={`badge drift-${summary.status}`}>
                      {statusText[summary.status]}
                    </span>
                  )}
                  {summary?.error ? <div className="status missing">{summary.error}</div> : null}
                  {checkError === undefined ? null : (
                    <div className="status missing">{checkError}</div>
                  )}
                </td>
                <td>
                  {summary === undefined || summary.status === "error" ? null : (
                    <>
                      {summary.changes}
                      {summary.destructive > 0 ? (
                        <span className="status missing"> ({summary.destructive} destructive)</span>
                      ) : null}
                      {summary.excluded > 0 ? (
                        <span className="muted"> ({summary.excluded} excluded)</span>
                      ) : null}
                    </>
                  )}
                </td>
                <td className="muted">
                  {summary === undefined
                    ? null
                    : `${new Date(summary.checkedAt).toLocaleString()} by ${summary.checkedBy.email}`}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={!row.hasKey || isRunning}
                    onClick={() => void checkOne(row.environmentId)}
                  >
                    {isRunning ? "Checking..." : "Check"}
                  </button>
                  <button
                    type="button"
                    disabled={!row.hasKey}
                    onClick={() =>
                      onCompare({
                        environmentId: row.environmentId,
                        environmentName: row.environmentName,
                        projectName: row.projectName,
                        projectId: row.projectId,
                      })
                    }
                  >
                    Compare
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
