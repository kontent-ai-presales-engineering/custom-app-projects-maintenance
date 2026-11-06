import { useCallback, useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type ConnectionResult,
  type EnvironmentView,
  getProjects,
  type ProjectOverviewData,
  type ProjectView,
  testConnection,
} from "../api/client.ts";

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
};

const EnvironmentRow = ({ environment, test, onTest }: EnvironmentRowProps) => (
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
      <button
        type="button"
        disabled={!environment.key.configured || test?.kind === "running"}
        onClick={() => onTest(environment.id)}
      >
        {test?.kind === "running" ? "Testing..." : "Test connection"}
      </button>
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
};

const ProjectCard = ({ project, tests, onTest }: ProjectCardProps) => {
  const missing = project.environments.filter((e) => !e.key.configured).length;

  return (
    <section className="project">
      <h3>
        {project.name}
        {project.isMasterProject ? <span className="badge">master project</span> : null}
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
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

export const ProjectOverview = ({ client }: { readonly client: ApiClient }) => {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({});

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
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
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
        <ProjectCard key={project.id} project={project} tests={tests} onTest={runTest} />
      ))}
    </div>
  );
};
