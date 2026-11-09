import {
  type ClientExclusions,
  type ItemSelection,
  type SelectableEntity,
  selectableEntities,
} from "../api/client.ts";

const labelOf = (entity: SelectableEntity) =>
  selectableEntities.find((e) => e.id === entity)?.label ?? entity;

type ExclusionsPanelProps = {
  readonly projectName: string;
  readonly exclusions: ClientExclusions | null;
  readonly error: string | null;
  readonly saving: boolean;
  readonly onChange: (items: ItemSelection) => void;
};

/** The items this client keeps out of syncs from the master, with a way to remove them. */
export const ExclusionsPanel = ({
  projectName,
  exclusions,
  error,
  saving,
  onChange,
}: ExclusionsPanelProps) => {
  const entries =
    exclusions === null
      ? []
      : selectableEntities.flatMap(({ id }) =>
          (exclusions.items[id] ?? []).map((codename) => ({ entity: id, codename })),
        );

  const remove = (entity: SelectableEntity, codename: string) => {
    if (exclusions === null) {
      return;
    }
    onChange({
      ...exclusions.items,
      [entity]: (exclusions.items[entity] ?? []).filter((c) => c !== codename),
    });
  };

  return (
    <section className="panel">
      <h3>Exclusions for {projectName}</h3>
      <p className="muted">
        Excluded items are never changed by a sync from the master, in any environment of this
        project. Use <strong>Exclude</strong> next to a change to add one. Restores are not
        affected.
      </p>
      {error === null ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {exclusions === null && error === null ? <p>Loading exclusions...</p> : null}
      {exclusions !== null && entries.length === 0 ? <p className="muted">No exclusions.</p> : null}
      {entries.length > 0 ? (
        <ul className="exclusions">
          {entries.map(({ entity, codename }) => (
            <li key={`${entity}:${codename}`}>
              {labelOf(entity)} <code>{codename}</code>{" "}
              <button type="button" disabled={saving} onClick={() => remove(entity, codename)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {exclusions?.updatedAt ? (
        <p className="muted">
          Last changed {new Date(exclusions.updatedAt).toLocaleString()} by{" "}
          {exclusions.updatedBy?.email}.
        </p>
      ) : null}
    </section>
  );
};
