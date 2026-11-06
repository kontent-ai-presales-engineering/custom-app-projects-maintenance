import { useState } from "react";
import {
  type ApiClient,
  ApiError,
  type DiffResult,
  type Impact,
  runDiff,
  type SelectableEntity,
  selectableEntities,
} from "../api/client.ts";

export type DiffTarget = Readonly<{
  environmentId: string;
  environmentName: string;
  projectName: string;
}>;

type RunState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "done"; readonly result: DiffResult };

const countText = (value: number | null) => (value === null ? "impact unknown" : String(value));

const ImpactCell = ({ impact }: { readonly impact: Impact }) => (
  <>
    <div>Latest: {countText(impact.latest)}</div>
    <div>Published: {countText(impact.published)}</div>
    {impact.unknownReasons.length > 0 ? (
      <ul className="muted reasons">
        {impact.unknownReasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    ) : null}
  </>
);

const Result = ({ result }: { readonly result: DiffResult }) => {
  const [showReport, setShowReport] = useState(false);

  if (result.inSync && result.blocks.length === 0) {
    return (
      <p className="status ok">
        {result.target.projectName} / {result.target.environmentName} is in sync with the master for
        the selected entities.
      </p>
    );
  }

  return (
    <div>
      {result.blocks.length > 0 ? (
        <section className="panel blocked">
          <h3>Blocked ({result.blocks.length})</h3>
          <p>This diff cannot be synced until these are resolved.</p>
          <ul>
            {result.blocks.map((block) => (
              <li key={`${block.entity}-${block.owner}-${block.reason}`}>
                <strong>
                  {block.entity} {block.owner}:
                </strong>{" "}
                {block.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.destructive.length > 0 ? (
        <section className="panel destructive">
          <h3>Destructive changes ({result.destructive.length})</h3>
          <p>
            Content in the client is lost or changed. Counts are language variants. "Impact unknown"
            always needs confirmation.
          </p>
          <table>
            <thead>
              <tr>
                <th>Where</th>
                <th>Change</th>
                <th>Affected content</th>
              </tr>
            </thead>
            <tbody>
              {result.destructive.map((change) => (
                <tr key={change.id}>
                  <td>
                    {change.entity} <code>{change.owner}</code>
                  </td>
                  <td>{change.description}</td>
                  <td>
                    <ImpactCell impact={change.impact} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {result.warnings.length > 0 ? (
        <section className="panel">
          <h3>Warnings</h3>
          <ul>
            {result.warnings.map((warning) => (
              <li key={`${warning.entity}-${warning.owner}`}>
                {warning.entity}: {warning.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <h3>All changes ({result.changes.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Entity</th>
              <th>Codename</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {result.changes.map((change) => (
              <tr key={`${change.entity}-${change.codename}-${change.kind}`}>
                <td>{change.entity}</td>
                <td>
                  <code>{change.codename}</code>
                </td>
                <td>
                  <span className={`badge kind-${change.kind}`}>{change.kind}</span>
                  {change.operations.length > 0 ? (
                    <details>
                      <summary>{change.operations.length} operations</summary>
                      <ul className="ops">
                        {change.operations.map((op, index) => (
                          <li key={`${index}-${op}`}>
                            <code>{op}</code>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {result.keptClientItems.length > 0 ? (
        <details className="panel">
          <summary>Client items kept ({result.keptClientItems.length})</summary>
          <p className="muted">
            These client-only items are not in the master. They are never removed by a sync.
          </p>
          <ul>
            {result.keptClientItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="toolbar">
        <button type="button" onClick={() => setShowReport((current) => !current)}>
          {showReport ? "Hide full report" : "Show full data-ops report"}
        </button>
      </div>
      {showReport ? (
        <iframe
          className="report"
          title="data-ops diff report"
          srcDoc={result.reportHtml}
          sandbox="allow-scripts"
        />
      ) : null}
    </div>
  );
};

type DiffViewProps = {
  readonly client: ApiClient;
  readonly target: DiffTarget;
  readonly onBack: () => void;
};

export const DiffView = ({ client, target, onBack }: DiffViewProps) => {
  const [entities, setEntities] = useState<ReadonlySet<SelectableEntity>>(
    () => new Set(selectableEntities.filter((e) => e.default).map((e) => e.id)),
  );
  const [state, setState] = useState<RunState>({ kind: "idle" });

  const toggle = (entity: SelectableEntity) =>
    setEntities((current) => {
      const next = new Set(current);
      if (next.has(entity)) {
        next.delete(entity);
      } else {
        next.add(entity);
      }
      return next;
    });

  const run = () => {
    setState({ kind: "running" });
    runDiff(client, target.environmentId, [...entities]).then(
      (result) => setState({ kind: "done", result }),
      (error: unknown) =>
        setState({
          kind: "error",
          message:
            error instanceof ApiError || error instanceof Error
              ? error.message
              : "Something went wrong",
        }),
    );
  };

  return (
    <div>
      <div className="toolbar">
        <h2>
          Compare master with {target.projectName} / {target.environmentName}
        </h2>
        <button type="button" onClick={onBack}>
          Back to projects
        </button>
      </div>

      <fieldset className="entities" disabled={state.kind === "running"}>
        <legend>Entities to compare</legend>
        {selectableEntities.map((entity) => (
          <label key={entity.id}>
            <input
              type="checkbox"
              checked={entities.has(entity.id)}
              onChange={() => toggle(entity.id)}
            />
            {entity.label}
            {entity.default ? null : <span className="muted"> (opt-in)</span>}
          </label>
        ))}
      </fieldset>

      <div className="toolbar">
        <button
          type="button"
          disabled={entities.size === 0 || state.kind === "running"}
          onClick={run}
        >
          {state.kind === "running" ? "Comparing..." : "Compare"}
        </button>
        <span className="muted">
          Read-only: nothing is changed in Kontent.ai. Large models can take a few minutes.
        </span>
      </div>

      {state.kind === "error" ? (
        <p className="error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === "done" ? <Result result={state.result} /> : null}
    </div>
  );
};
