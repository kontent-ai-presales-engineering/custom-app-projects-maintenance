import { useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type ConnectionResult,
  cloneEnvironment,
  getCloningState,
  type ProjectView,
  selectableEntities,
  testConnection,
} from "../api/client.ts";
import type { DiffTarget } from "./DiffView.tsx";

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong";

/** The project-level key variable: covers every environment of the project, including clones. */
const projectKeyVariable = (projectId: string) =>
  `KONTENT_MAPI_KEY_${projectId.toLowerCase().replaceAll("-", "_")}`;

type Clone =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "cloning";
      readonly environmentId: string;
      readonly name: string;
      readonly state: string;
    }
  | { readonly kind: "error"; readonly message: string };

type TestState =
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly result: ConnectionResult }
  | { readonly kind: "failed"; readonly message: string };

/** How often the cloning state is checked. */
const pollMs = 5000;

type OnboardingViewProps = {
  readonly client: ApiClient;
  readonly project: ProjectView;
  readonly onBack: () => void;
  readonly onCompare: (target: DiffTarget) => void;
};

export const OnboardingView = ({ client, project, onBack, onCompare }: OnboardingViewProps) => {
  const withKey = project.environments.filter((environment) => environment.key.configured);
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({});
  const [sourceId, setSourceId] = useState(withKey[0]?.id ?? "");
  const [name, setName] = useState("Develop");
  const [copyContent, setCopyContent] = useState(false);
  const [clone, setClone] = useState<Clone>({ kind: "idle" });

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

  const startClone = () => {
    setClone({ kind: "starting" });
    cloneEnvironment(client, sourceId, name, copyContent).then(
      (result) =>
        setClone({
          kind: "cloning",
          environmentId: result.environmentId,
          name: result.name,
          state: "started",
        }),
      (error: unknown) => setClone({ kind: "error", message: errorMessage(error) }),
    );
  };

  // Follow the cloning state until it is done.
  const cloningId = clone.kind === "cloning" ? clone.environmentId : null;
  const cloningDone = clone.kind === "cloning" && clone.state === "done";
  useEffect(() => {
    if (cloningId === null || cloningDone) {
      return;
    }
    const timer = setInterval(() => {
      getCloningState(client, project.id, cloningId).then(
        (state) =>
          setClone((current) => (current.kind === "cloning" ? { ...current, state } : current)),
        (error: unknown) =>
          setClone((current) =>
            current.kind === "cloning" ? { ...current, state: errorMessage(error) } : current,
          ),
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [client, project.id, cloningId, cloningDone]);

  const testText = (environmentId: string) => {
    const test = tests[environmentId];
    if (test === undefined) {
      return null;
    }
    if (test.kind === "running") {
      return <span className="muted">Testing...</span>;
    }
    if (test.kind === "failed") {
      return <span className="status missing">{test.message}</span>;
    }
    const { result } = test;
    return result.status === "ok" ? (
      <span className="status ok">Connected</span>
    ) : (
      <span className="status missing">{"message" in result ? result.message : "No key"}</span>
    );
  };

  return (
    <div>
      <div className="toolbar">
        <h2>Onboarding {project.name}</h2>
        <button type="button" onClick={onBack}>
          Back to projects
        </button>
      </div>
      <p className="muted">
        Kontent.ai has no API to create projects. Create the client project in Kontent.ai first; it
        then appears here. These steps connect it and give it the master's content model.
      </p>

      <section className="panel">
        <h3>1. Add a Management API key</h3>
        <p>
          Create a Management API key in the client project, then add it in Vercel as{" "}
          <code className="selectable">{projectKeyVariable(project.id)}</code> and redeploy. A
          project-level key covers all environments of the project, including ones you clone later,
          if the key itself is not limited to specific environments.
        </p>
        <p className={withKey.length > 0 ? "status ok" : "status missing"}>
          {withKey.length} of {project.environments.length} environments have a key.
        </p>
      </section>

      <section className="panel">
        <h3>2. Test the connection</h3>
        <table>
          <tbody>
            {project.environments.map((environment) => (
              <tr key={environment.id}>
                <td>{environment.name}</td>
                <td>
                  <button
                    type="button"
                    disabled={
                      !environment.key.configured || tests[environment.id]?.kind === "running"
                    }
                    onClick={() => runTest(environment.id)}
                  >
                    Test connection
                  </button>{" "}
                  {testText(environment.id)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h3>3. Initial sync</h3>
        <p>
          Opens the comparison with every entity selected (content types, snippets, taxonomies,
          collections, spaces, languages and workflows). Review it, then sync as usual. You can
          compare with the live master or a release there.
        </p>
        <table>
          <tbody>
            {project.environments.map((environment) => (
              <tr key={environment.id}>
                <td>{environment.name}</td>
                <td>
                  <button
                    type="button"
                    disabled={!environment.key.configured}
                    onClick={() =>
                      onCompare({
                        environmentId: environment.id,
                        environmentName: environment.name,
                        projectName: project.name,
                        projectId: project.id,
                        initialEntities: selectableEntities.map((entity) => entity.id),
                      })
                    }
                  >
                    Initial sync of {environment.name}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h3>4. Optional: create another environment</h3>
        <p className="muted">
          Clones an environment of this project, for example to create a development environment
          after the initial sync. The key needs the Manage environments permission.
        </p>
        <label className="confirm">
          Clone from{" "}
          <select
            value={sourceId}
            disabled={clone.kind === "starting" || clone.kind === "cloning"}
            onChange={(event) => setSourceId(event.target.value)}
          >
            {withKey.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        </label>
        <label className="confirm">
          New environment name
          <input
            type="text"
            value={name}
            maxLength={50}
            disabled={clone.kind === "starting" || clone.kind === "cloning"}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="confirm">
          <input
            type="checkbox"
            checked={copyContent}
            disabled={clone.kind === "starting" || clone.kind === "cloning"}
            onChange={(event) => setCopyContent(event.target.checked)}
          />
          Also copy content items and assets (otherwise only the content model and settings)
        </label>
        <button
          type="button"
          disabled={
            sourceId === "" ||
            name.trim() === "" ||
            clone.kind === "starting" ||
            clone.kind === "cloning"
          }
          onClick={startClone}
        >
          {clone.kind === "starting" ? "Starting..." : "Clone environment"}
        </button>
        {clone.kind === "error" ? (
          <p className="error" role="alert">
            {clone.message}
          </p>
        ) : null}
        {clone.kind === "cloning" ? (
          <output className={`status ${cloningDone ? "ok" : ""}`}>
            {cloningDone
              ? `Environment "${clone.name}" is ready. Go back to projects and click Refresh to see it (the list can take up to a minute to update).`
              : `Cloning "${clone.name}": ${clone.state}. This can take several minutes.`}
          </output>
        ) : null}
      </section>
    </div>
  );
};
