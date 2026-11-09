import { useCallback, useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type ConnectionResult,
  type EnvironmentMetrics,
  type EnvironmentView,
  getMetrics,
  getProjects,
  type MetricsOverview,
  type ProjectOverviewData,
  type ProjectView,
  refreshMetrics,
  testConnection,
} from "../api/client.ts";
import type { DiffTarget } from "./DiffView.tsx";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: ProjectOverviewData };

type TestState =
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly result: ConnectionResult }
  | { readonly kind: "failed"; readonly message: string };

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

const describeResult = (result: ConnectionResult): string => {
  switch (result.status) {
    case "ok":
      return `Connected to ${result.projectName} / ${result.environmentName}${
        result.isProduction ? " (production)" : ""
      }. Key from the ${result.keySource} variable.`;
    case "key_missing":
      return `No key. Add ${result.variableName} in Vercel and redeploy.`;
    default:
      return `${result.message} (variable ${result.variableName})`;
  }
};

const KeyCell = ({ environment }: { readonly environment: EnvironmentView }) =>
  environment.key.configured ? (
    <span className="status ok">
      Key configured{environment.key.source === "project" ? " (project key)" : ""}
    </span>
  ) : (
    <span className="status missing">
      Key missing: add <code className="selectable">{environment.key.variableName}</code>
    </span>
  );

type EnvironmentRowProps = {
  readonly environment: EnvironmentView;
  readonly test: TestState | undefined;
  readonly onTest: (environmentId: string) => void;
  /** Set for client environments only. */
  readonly onCompare: (() => void) | null;
  readonly metrics: EnvironmentMetrics | undefined;
  readonly refreshing: boolean;
  readonly onRefreshMetrics: (environmentId: string) => void;
};

const countText = (value: number | null, singular: string, plural: string) =>
  value === null ? `? ${plural}` : `${value.toLocaleString()} ${value === 1 ? singular : plural}`;

const MetricsCell = ({
  environment,
  metrics,
  refreshing,
  onRefresh,
}: Readonly<{
  environment: EnvironmentView;
  metrics: EnvironmentMetrics | undefined;
  refreshing: boolean;
  onRefresh: (environmentId: string) => void;
}>) => (
  <>
    {metrics === undefined ? (
      <span className="muted">Not counted</span>
    ) : (
      <>
        <div>
          {countText(metrics.contentItems, "item", "items")} ·{" "}
          {countText(metrics.contentTypes, "type", "types")}
        </div>
        <div className="muted small">
          {new Date(metrics.countedAt).toLocaleString()}
          {metrics.error === null ? null : <span className="status missing"> {metrics.error}</span>}
        </div>
      </>
    )}
    <button
      type="button"
      className="link"
      disabled={!environment.key.configured || refreshing}
      onClick={() => onRefresh(environment.id)}
    >
      {refreshing ? "Counting..." : "Refresh"}
    </button>
  </>
);

const EnvironmentRow = ({
  environment,
  test,
  onTest,
  onCompare,
  metrics,
  refreshing,
  onRefreshMetrics,
}: EnvironmentRowProps) => (
  <tr>
    <td>
      {environment.name}
      {environment.isMaster ? <span className="badge">master</span> : null}
    </td>
    <td>
      <code className="selectable">{environment.id}</code>
    </td>
    <td>
      <KeyCell environment={environment} />
    </td>
    <td>
      <MetricsCell
        environment={environment}
        metrics={metrics}
        refreshing={refreshing}
        onRefresh={onRefreshMetrics}
      />
    </td>
    <td>
      <button
        type="button"
        disabled={!environment.key.configured || test?.kind === "running"}
        onClick={() => onTest(environment.id)}
      >
        {test?.kind === "running" ? "Testing..." : "Test connection"}
      </button>
      {onCompare === null ? null : (
        <button type="button" disabled={!environment.key.configured} onClick={onCompare}>
          Compare with master
        </button>
      )}
      {test?.kind === "done" && (
        <output className={`status ${test.result.status === "ok" ? "ok" : "missing"}`}>
          {describeResult(test.result)}
        </output>
      )}
      {test?.kind === "failed" && <output className="status missing">{test.message}</output>}
    </td>
  </tr>
);

type ProjectCardProps = {
  readonly project: ProjectView;
  readonly tests: Readonly<Record<string, TestState>>;
  readonly onTest: (environmentId: string) => void;
  readonly onCompare: (target: DiffTarget) => void;
  readonly onOnboard: (project: ProjectView) => void;
  readonly metrics: MetricsOverview | null;
  readonly refreshing: ReadonlySet<string>;
  readonly onRefreshMetrics: (environmentId: string) => void;
};

const ProjectCard = ({
  project,
  tests,
  onTest,
  onCompare,
  onOnboard,
  metrics,
  refreshing,
  onRefreshMetrics,
}: ProjectCardProps) => {
  const users = metrics?.projects[project.id.toLowerCase()];
  const missing = project.environments.filter((e) => !e.key.configured).length;

  return (
    <section className="project">
      <h3>
        {project.name}
        {project.isMasterProject ? <span className="badge">master project</span> : null}
        {project.isMasterProject ? null : (
          <button type="button" className="link" onClick={() => onOnboard(project)}>
            Onboarding
          </button>
        )}
        {users === undefined ? null : (
          <span className="badge muted">
            {users.total} {users.total === 1 ? "user" : "users"} ({users.active} active)
          </span>
        )}
        {!project.isActive && <span className="badge muted">inactive</span>}
        {!project.isMasterProject && missing > 0 && (
          <span className="badge warn">
            {missing} {missing === 1 ? "key" : "keys"} missing
          </span>
        )}
      </h3>
      {project.environments.length === 0 ? (
        <p className="muted">No environments.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Environment</th>
              <th>Environment ID</th>
              <th>Management API key</th>
              <th>Content</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {project.environments.map((environment) => (
              <EnvironmentRow
                key={environment.id}
                environment={environment}
                test={tests[environment.id]}
                onTest={onTest}
                metrics={metrics?.environments[environment.id.toLowerCase()]}
                refreshing={refreshing.has(environment.id)}
                onRefreshMetrics={onRefreshMetrics}
                onCompare={
                  project.isMasterProject
                    ? null
                    : () =>
                        onCompare({
                          environmentId: environment.id,
                          environmentName: environment.name,
                          projectName: project.name,
                          projectId: project.id,
                        })
                }
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

type ProjectOverviewProps = {
  readonly client: ApiClient;
  readonly onCompare: (target: DiffTarget) => void;
  readonly onOnboard: (project: ProjectView) => void;
};

export const ProjectOverview = ({ client, onCompare, onOnboard }: ProjectOverviewProps) => {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({});
  const [metrics, setMetrics] = useState<MetricsOverview | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());

  const loadMetrics = useCallback(() => {
    getMetrics(client).then(
      (loaded) => {
        setMetrics(loaded);
        setMetricsError(loaded.usersError);
      },
      (error: unknown) => setMetricsError(errorMessage(error)),
    );
  }, [client]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const refreshOne = async (environmentId: string) => {
    setRefreshing((current) => new Set(current).add(environmentId));
    try {
      const counted = await refreshMetrics(client, environmentId);
      setMetrics((current) =>
        current === null
          ? current
          : {
              ...current,
              environments: { ...current.environments, [counted.environmentId]: counted },
            },
      );
    } catch (error) {
      setMetricsError(errorMessage(error));
    } finally {
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
    }
  };

  /** Counts every environment with a key, two at a time. */
  const refreshAll = async (ids: ReadonlyArray<string>) => {
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        await refreshOne(id);
      }
    };
    await Promise.all([worker(), worker()]);
  };

  const load = useCallback(() => {
    setState({ kind: "loading" });
    getProjects(client).then(
      (data) => setState({ kind: "ready", data }),
      (error: unknown) => setState({ kind: "error", message: errorMessage(error) }),
    );
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const runTest = (environmentId: string) => {
    setTests((current) => ({ ...current, [environmentId]: { kind: "running" } }));
    testConnection(client, environmentId).then(
      (result) =>
        setTests((current) => ({ ...current, [environmentId]: { kind: "done", result } })),
      (error: unknown) =>
        setTests((current) => ({
          ...current,
          [environmentId]: { kind: "failed", message: errorMessage(error) },
        })),
    );
  };

  if (state.kind === "loading") {
    return <p>Loading projects...</p>;
  }
  if (state.kind === "error") {
    return (
      <div>
        <p className="error" role="alert">
          Could not load projects: {state.message}
        </p>
        <button type="button" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  const { projects, masterFound } = state.data;

  return (
    <div>
      <div className="toolbar">
        <h2>Projects in the subscription</h2>
        <span>
          <button
            type="button"
            disabled={refreshing.size > 0}
            onClick={() =>
              void refreshAll(
                projects.flatMap((project) =>
                  project.environments.filter((e) => e.key.configured).map((e) => e.id),
                ),
              )
            }
          >
            {refreshing.size > 0 ? `Counting (${refreshing.size})...` : "Refresh all metrics"}
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              load();
              loadMetrics();
            }}
          >
            Refresh
          </button>
        </span>
      </div>
      {metricsError === null ? null : <p className="status missing">{metricsError}</p>}
      {!masterFound && (
        <p className="error" role="alert">
          The master environment (KONTENT_MASTER_ENVIRONMENT_ID) is not in this subscription. Check
          the configuration.
        </p>
      )}
      <p className="muted">
        After adding a key in Vercel, redeploy and click Refresh. The project list is cached for up
        to a minute.
      </p>
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          tests={tests}
          onTest={runTest}
          onCompare={onCompare}
          onOnboard={onOnboard}
          metrics={metrics}
          refreshing={refreshing}
          onRefreshMetrics={(id) => void refreshOne(id)}
        />
      ))}
    </div>
  );
};
