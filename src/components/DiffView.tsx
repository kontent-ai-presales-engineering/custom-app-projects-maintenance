import { useEffect, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type BackupMetadata,
  type ClientExclusions,
  type DiffResult,
  getExclusions,
  getReleases,
  type Impact,
  type ItemSelection,
  type ReleaseMetadata,
  runDiff,
  type SelectableEntity,
  saveExclusions,
  selectableEntities,
} from "../api/client.ts";
import { BackupPanel } from "./BackupPanel.tsx";
import { ExclusionsPanel } from "./ExclusionsPanel.tsx";
import { SyncPanel } from "./SyncPanel.tsx";

export type DiffTarget = Readonly<{
  environmentId: string;
  environmentName: string;
  projectName: string;
  projectId: string;
  /** Entities to preselect, for example all of them for an initial sync. */
  initialEntities?: ReadonlyArray<SelectableEntity>;
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

/** Maps the change list's entity labels to the API's entity names. */
const entityKeyByLabel: Readonly<Record<string, SelectableEntity>> = {
  "Content type": "contentTypes",
  Snippet: "contentTypeSnippets",
  "Taxonomy group": "taxonomies",
  Collection: "collections",
  Space: "spaces",
  Language: "languages",
  Workflow: "workflows",
};

export const itemKey = (entity: SelectableEntity, codename: string) => `${entity}:${codename}`;

type ResultProps = {
  readonly result: DiffResult;
  /** Chosen items (entity:codename) when choosing items, otherwise null. */
  readonly chosen: ReadonlySet<string> | null;
  readonly onToggle: (key: string) => void;
  /** Set when changes can be excluded for this client (syncs from the master). */
  readonly onExclude: ((entity: SelectableEntity, codename: string) => void) | null;
};

const Result = ({ result, chosen, onToggle, onExclude }: ResultProps) => {
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

      {result.selection === null ? null : (
        <section className="panel restore">
          <h3>Selected items only</h3>
          <p>
            This diff is limited to the items you chose.
            {result.selection.dependencies.length === 0
              ? " Nothing else was needed."
              : " These were added because the chosen items need them:"}
          </p>
          {result.selection.dependencies.length === 0 ? null : (
            <ul>
              {result.selection.dependencies.map((dependency) => (
                <li key={itemKey(dependency.entity, dependency.codename)}>
                  <code>{dependency.codename}</code>: {dependency.reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel">
        <h3>All changes ({result.changes.length})</h3>
        {chosen === null ? null : (
          <p className="muted">Tick the items to sync, then click Compare selected items.</p>
        )}
        <table>
          <thead>
            <tr>
              {chosen === null ? null : <th />}
              <th>Entity</th>
              <th>Codename</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {result.changes.map((change) => (
              <tr key={`${change.entity}-${change.codename}-${change.kind}`}>
                {chosen === null ? null : (
                  <td>
                    {entityKeyByLabel[change.entity] === undefined ? null : (
                      <input
                        type="checkbox"
                        aria-label={`Sync ${change.codename}`}
                        checked={chosen.has(
                          itemKey(entityKeyByLabel[change.entity], change.codename),
                        )}
                        onChange={() =>
                          onToggle(itemKey(entityKeyByLabel[change.entity], change.codename))
                        }
                      />
                    )}
                  </td>
                )}
                <td>{change.entity}</td>
                <td>
                  <code>{change.codename}</code>
                </td>
                <td>
                  <span className={`badge kind-${change.kind}`}>{change.kind}</span>
                  {onExclude === null ||
                  chosen !== null ||
                  entityKeyByLabel[change.entity] === undefined ? null : (
                    <button
                      type="button"
                      className="link"
                      onClick={() => onExclude(entityKeyByLabel[change.entity], change.codename)}
                    >
                      Exclude
                    </button>
                  )}
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

      {result.excludedItems.length > 0 ? (
        <details className="panel">
          <summary>Excluded for this client, kept as is ({result.excludedItems.length})</summary>
          <p className="muted">
            The master has changes to these items, but this client excludes them. They are not
            synced.
          </p>
          <ul>
            {result.excludedItems.map((item) => (
              <li key={itemKey(item.entity, item.codename)}>
                <code>{item.codename}</code> ({item.kind} in the master)
              </li>
            ))}
          </ul>
        </details>
      ) : null}

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
    () =>
      new Set(
        target.initialEntities ?? selectableEntities.filter((e) => e.default).map((e) => e.id),
      ),
  );
  const [state, setState] = useState<RunState>({ kind: "idle" });
  // Bumped after a sync so the backup list shows the new pre-sync backup.
  const [backupsVersion, setBackupsVersion] = useState(0);
  // Set when restoring: the client is compared with this backup instead of the master.
  const [restoreFrom, setRestoreFrom] = useState<BackupMetadata | null>(null);

  const chooseRestore = (backup: BackupMetadata | null) => {
    setRestoreFrom(backup);
    setState({ kind: "idle" });
    window.scrollTo({ top: 0 });
  };

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

  // Item keys (entity:codename) ticked while choosing items; null when not choosing.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);

  const [notice, setNotice] = useState<string | null>(null);

  // Master releases to compare with instead of the live master; null means live master.
  const [releases, setReleases] = useState<ReadonlyArray<ReleaseMetadata>>([]);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getReleases(client).then(
      (data) => !cancelled && setReleases(data.releases),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  // The client's exclusions. Changing them invalidates the current diff.
  const [exclusions, setExclusions] = useState<ClientExclusions | null>(null);
  const [exclusionsError, setExclusionsError] = useState<string | null>(null);
  const [savingExclusions, setSavingExclusions] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getExclusions(client, target.projectId).then(
      (loaded) => !cancelled && setExclusions(loaded),
      (error: unknown) =>
        !cancelled &&
        setExclusionsError(error instanceof Error ? error.message : "Could not load exclusions"),
    );
    return () => {
      cancelled = true;
    };
  }, [client, target.projectId]);

  const updateExclusions = (items: ItemSelection) => {
    setSavingExclusions(true);
    setExclusionsError(null);
    saveExclusions(client, target.projectId, items).then(
      (saved) => {
        setSavingExclusions(false);
        setExclusions(saved);
        // The diff on screen no longer matches what a sync would do.
        setState({ kind: "idle" });
        setNotice("Exclusions changed. Compare again to see the updated diff.");
      },
      (error: unknown) => {
        setSavingExclusions(false);
        setExclusionsError(error instanceof Error ? error.message : "Could not save exclusions");
      },
    );
  };

  const exclude = (entity: SelectableEntity, codename: string) => {
    const current = exclusions?.items ?? {};
    updateExclusions({ ...current, [entity]: [...(current[entity] ?? []), codename] });
  };

  const toggleItem = (key: string) =>
    setChosen((current) => {
      const next = new Set(current ?? []);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  /** Builds the selection: every compared entity is limited to its ticked items. */
  const selectionFrom = (keys: ReadonlySet<string>): ItemSelection =>
    Object.fromEntries(
      [...entities].map((entity) => [
        entity,
        [...keys]
          .filter((key) => key.startsWith(`${entity}:`))
          .map((key) => key.slice(entity.length + 1)),
      ]),
    );

  const run = (items?: ItemSelection) => {
    setState({ kind: "running" });
    setNotice(null);
    setChosen(null);
    runDiff(client, target.environmentId, [...entities], {
      restoreFrom: restoreFrom?.id,
      release: restoreFrom === null ? (releaseId ?? undefined) : undefined,
      items,
    }).then(
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
          {restoreFrom === null
            ? `Compare master with ${target.projectName} / ${target.environmentName}`
            : `Restore ${target.projectName} / ${target.environmentName} from a backup`}
        </h2>
        <button type="button" onClick={onBack}>
          Back to projects
        </button>
      </div>

      {restoreFrom === null && releases.length > 0 ? (
        <label className="confirm">
          Compare with:{" "}
          <select
            value={releaseId ?? ""}
            disabled={state.kind === "running"}
            onChange={(event) => {
              setReleaseId(event.target.value === "" ? null : event.target.value);
              setState({ kind: "idle" });
            }}
          >
            <option value="">Live master</option>
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                Release {release.version} ({new Date(release.createdAt).toLocaleDateString()})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {restoreFrom === null ? null : (
        <div className="panel restore">
          <p>
            Comparing the client with its backup from{" "}
            <strong>{new Date(restoreFrom.createdAt).toLocaleString()}</strong> (made by{" "}
            {restoreFrom.createdBy.email}). Restoring brings the chosen parts of the content model
            back to that state. Client items with the reserved prefix added since then are kept.
            Content is not restored.
          </p>
          <button type="button" onClick={() => chooseRestore(null)}>
            Cancel restore, compare with master
          </button>
        </div>
      )}

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
          onClick={() => run()}
        >
          {state.kind === "running"
            ? "Comparing..."
            : restoreFrom === null
              ? "Compare"
              : "Compare with backup"}
        </button>
        <span className="muted">
          Read-only: nothing is changed in Kontent.ai. Large models can take a few minutes.
        </span>
      </div>

      {notice === null ? null : <output className="status">{notice}</output>}
      {state.kind === "error" ? (
        <p className="error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === "done" && !state.result.inSync ? (
        <div className="toolbar">
          {chosen === null ? (
            <button type="button" onClick={() => setChosen(new Set())}>
              Choose items...
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={chosen.size === 0}
                onClick={() => run(selectionFrom(chosen))}
              >
                Compare selected items ({chosen.size})
              </button>
              <button type="button" onClick={() => setChosen(null)}>
                Cancel
              </button>
            </>
          )}
          {state.result.selection === null ? null : (
            <button type="button" onClick={() => run()}>
              Compare all items again
            </button>
          )}
        </div>
      ) : null}
      {state.kind === "done" ? (
        <Result
          result={state.result}
          chosen={chosen}
          onToggle={toggleItem}
          onExclude={
            restoreFrom === null && exclusions !== null && !savingExclusions ? exclude : null
          }
        />
      ) : null}
      {state.kind === "done" && state.result.blocks.length === 0 && !state.result.inSync ? (
        <SyncPanel
          key={state.result.diffHash}
          client={client}
          result={state.result}
          onFinished={() => setBackupsVersion((version) => version + 1)}
        />
      ) : null}

      {restoreFrom === null ? (
        <ExclusionsPanel
          projectName={target.projectName}
          exclusions={exclusions}
          error={exclusionsError}
          saving={savingExclusions}
          onChange={updateExclusions}
        />
      ) : null}

      <BackupPanel
        key={backupsVersion}
        client={client}
        environmentId={target.environmentId}
        onRestore={chooseRestore}
      />
    </div>
  );
};
