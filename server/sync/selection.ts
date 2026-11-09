import { z } from "zod";
import { pathCodenames } from "./clientPrefix.js";
import {
  type DiffModel,
  type PatchOperation,
  type SelectableEntity,
  selectableEntities,
} from "./dataOps.js";

/**
 * Items chosen per entity, by codename. An entity that is not listed is synced whole;
 * an entity with a list is restricted to those items.
 */
export type ItemSelection = Readonly<Partial<Record<SelectableEntity, ReadonlyArray<string>>>>;

/** Request validation: per entity, a list of codenames (at most 500 per entity). */
export const itemsSchema = z.partialRecord(
  z.enum(selectableEntities),
  z.array(z.string().min(1).max(200)).max(500),
);

export type Dependency = Readonly<{
  entity: SelectableEntity;
  codename: string;
  /** Why it was included, for example 'used by content type "article"'. */
  reason: string;
}>;

export type SelectionResult = Readonly<{
  model: DiffModel;
  /** Items that were not chosen but had to be included. */
  dependencies: ReadonlyArray<Dependency>;
}>;

/** Fields in data-ops sync models that refer to other entities by codename. */
const referenceFields: Readonly<Record<string, SelectableEntity>> = {
  snippet: "contentTypeSnippets",
  taxonomy_group: "taxonomies",
  allowed_content_types: "contentTypes",
  allowed_item_link_types: "contentTypes",
  content_types: "contentTypes",
  collections: "collections",
};

type Ref = Readonly<{ entity: SelectableEntity; codename: string }>;

/** All entity references inside a value, for example the snippet used by an element. */
export const findReferences = (value: unknown): ReadonlyArray<Ref> => {
  const refs: Ref[] = [];
  const codenamesOf = (v: unknown): ReadonlyArray<string> =>
    (Array.isArray(v) ? v : [v]).flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { codename?: unknown }).codename === "string"
        ? [(entry as { codename: string }).codename]
        : [],
    );
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v !== "object" || v === null) {
      return;
    }
    for (const [key, child] of Object.entries(v)) {
      const entity = referenceFields[key];
      if (entity !== undefined) {
        refs.push(...codenamesOf(child).map((codename) => ({ entity, codename })));
      }
      walk(child);
    }
  };
  walk(value);
  return refs;
};

type Item = Readonly<{
  entity: SelectableEntity;
  codename: string;
  kind: "added" | "updated" | "deleted";
  /** Values the change writes (references it needs to exist). */
  writes: ReadonlyArray<unknown>;
  /** Values the change removes (references it takes away). */
  removes: ReadonlyArray<unknown>;
}>;

const objectEntities = [
  ["contentTypes", "contentTypes"],
  ["contentTypeSnippets", "contentTypeSnippets"],
  ["taxonomies", "taxonomyGroups"],
  ["spaces", "spaces"],
  ["languages", "languages"],
  ["workflows", "workflows"],
] as const;

const writesOf = (ops: ReadonlyArray<PatchOperation>) =>
  ops.flatMap((op) => (op.op === "addInto" || op.op === "replace" ? [op.value] : []));
const removesOf = (ops: ReadonlyArray<PatchOperation>) =>
  ops.flatMap((op) => (op.op === "remove" || op.op === "replace" ? [op.oldValue] : []));

const collectItems = (model: DiffModel): ReadonlyArray<Item> => {
  const items: Item[] = [];
  for (const [entity, key] of objectEntities) {
    const diff = model[key];
    for (const added of diff.added) {
      items.push({ entity, codename: added.codename, kind: "added", writes: [added], removes: [] });
    }
    for (const [codename, ops] of diff.updated) {
      items.push({
        entity,
        codename,
        kind: "updated",
        writes: writesOf(ops),
        removes: removesOf(ops),
      });
    }
    for (const codename of diff.deleted) {
      items.push({ entity, codename, kind: "deleted", writes: [], removes: [] });
    }
  }
  for (const op of model.collections) {
    const codename =
      pathCodenames(op.path)[0] ?? (op.op === "addInto" ? codenameOf(op.value) : null);
    if (codename !== null) {
      items.push({
        entity: "collections",
        codename,
        kind: op.op === "remove" ? "deleted" : op.op === "addInto" ? "added" : "updated",
        writes: writesOf([op]),
        removes: [],
      });
    }
  }
  return items;
};

const codenameOf = (value: unknown): string | null =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { codename?: unknown }).codename === "string"
    ? (value as { codename: string }).codename
    : null;

const keyOf = (entity: SelectableEntity, codename: string) => `${entity}:${codename}`;

const entityLabel: Record<SelectableEntity, string> = {
  contentTypes: "content type",
  contentTypeSnippets: "snippet",
  taxonomies: "taxonomy group",
  collections: "collection",
  spaces: "space",
  languages: "language",
  workflows: "workflow",
};

/**
 * Restricts a diff to the chosen items plus what they depend on. Only removes
 * operations: never adds or changes any.
 */
export const restrictToItems = (model: DiffModel, selection: ItemSelection): SelectionResult => {
  const restricted = new Set(Object.keys(selection) as SelectableEntity[]);
  if (restricted.size === 0) {
    return { model, dependencies: [] };
  }

  const items = collectItems(model);
  const byKey = new Map(items.map((item) => [keyOf(item.entity, item.codename), item]));
  const included = new Set<string>();
  const dependencies: Dependency[] = [];

  // Items of entities without a list are all included.
  for (const item of items) {
    const chosen = selection[item.entity];
    if (chosen === undefined || chosen.includes(item.codename)) {
      included.add(keyOf(item.entity, item.codename));
    }
  }

  const include = (item: Item, reason: string) => {
    const key = keyOf(item.entity, item.codename);
    if (!included.has(key)) {
      included.add(key);
      dependencies.push({ entity: item.entity, codename: item.codename, reason });
      queue.push(item);
    }
  };

  const queue = items.filter((item) => included.has(keyOf(item.entity, item.codename)));
  while (queue.length > 0) {
    const item = queue.shift() as Item;
    const owner = `${entityLabel[item.entity]} "${item.codename}"`;

    // Something new that this item refers to must be created with it.
    for (const ref of item.writes.flatMap(findReferences)) {
      const target = byKey.get(keyOf(ref.entity, ref.codename));
      if (target?.kind === "added") {
        include(target, `used by ${owner}`);
      }
    }

    // A deletion only succeeds once the updates that drop references to it are applied.
    if (item.kind === "deleted") {
      for (const other of items) {
        if (
          other.kind === "updated" &&
          other.removes
            .flatMap(findReferences)
            .some((ref) => ref.entity === item.entity && ref.codename === item.codename)
        ) {
          include(other, `stops using ${owner}, which is deleted`);
        }
      }
    }
  }

  const keep = (entity: SelectableEntity, codename: string) =>
    !restricted.has(entity) || included.has(keyOf(entity, codename));

  const restrictObject = <
    T extends Readonly<{
      added: ReadonlyArray<{ codename: string }>;
      updated: ReadonlyMap<string, ReadonlyArray<PatchOperation>>;
      deleted: ReadonlySet<string>;
    }>,
  >(
    entity: SelectableEntity,
    diff: T,
  ): T => ({
    ...diff,
    added: diff.added.filter((added) => keep(entity, added.codename)),
    updated: new Map([...diff.updated].filter(([codename]) => keep(entity, codename))),
    deleted: new Set([...diff.deleted].filter((codename) => keep(entity, codename))),
  });

  return {
    model: {
      ...model,
      contentTypes: restrictObject("contentTypes", model.contentTypes),
      contentTypeSnippets: restrictObject("contentTypeSnippets", model.contentTypeSnippets),
      taxonomyGroups: restrictObject("taxonomies", model.taxonomyGroups),
      spaces: restrictObject("spaces", model.spaces),
      languages: restrictObject("languages", model.languages),
      workflows: restrictObject("workflows", model.workflows),
      collections: model.collections.filter((op) => {
        const codename =
          pathCodenames(op.path)[0] ?? (op.op === "addInto" ? codenameOf(op.value) : null);
        return codename === null || keep("collections", codename);
      }),
    },
    dependencies,
  };
};

/** Items a client keeps out of syncs, per entity, by codename. Same shape as a selection. */
export type Exclusions = ItemSelection;

export type ExclusionResult = Readonly<{
  model: DiffModel;
  /** Items that had changes and were left out because they are excluded. */
  excluded: ReadonlyArray<
    Readonly<{ entity: SelectableEntity; codename: string; kind: Item["kind"] }>
  >;
  /** Synced items that cannot work without an excluded item. Each one blocks the sync. */
  conflicts: ReadonlyArray<Dependency>;
}>;

/**
 * Drops every change to an excluded item. Unlike a selection, it never pulls excluded
 * items back in: when a synced item needs one, that is reported as a conflict.
 */
export const excludeItems = (model: DiffModel, exclusions: Exclusions): ExclusionResult => {
  const isExcluded = (entity: SelectableEntity, codename: string) =>
    exclusions[entity]?.includes(codename) ?? false;

  const items = collectItems(model);
  const excluded = items.filter((item) => isExcluded(item.entity, item.codename));
  if (excluded.length === 0) {
    return { model, excluded: [], conflicts: [] };
  }
  const kept = items.filter((item) => !isExcluded(item.entity, item.codename));
  const conflicts: Dependency[] = [];

  for (const item of kept) {
    const owner = `${entityLabel[item.entity]} "${item.codename}"`;
    for (const ref of item.writes.flatMap(findReferences)) {
      const needed = excluded.find(
        (e) => e.entity === ref.entity && e.codename === ref.codename && e.kind === "added",
      );
      if (needed !== undefined) {
        conflicts.push({
          entity: item.entity,
          codename: item.codename,
          reason: `${owner} uses ${entityLabel[needed.entity]} "${needed.codename}", which is new in the master but excluded for this client`,
        });
      }
    }
    if (item.kind === "deleted") {
      for (const other of excluded) {
        if (
          other.kind === "updated" &&
          other.removes
            .flatMap(findReferences)
            .some((ref) => ref.entity === item.entity && ref.codename === item.codename)
        ) {
          conflicts.push({
            entity: item.entity,
            codename: item.codename,
            reason: `deleting ${owner} needs the update of excluded ${entityLabel[other.entity]} "${other.codename}"`,
          });
        }
      }
    }
  }

  const keepObject = <
    T extends Readonly<{
      added: ReadonlyArray<{ codename: string }>;
      updated: ReadonlyMap<string, ReadonlyArray<PatchOperation>>;
      deleted: ReadonlySet<string>;
    }>,
  >(
    entity: SelectableEntity,
    diff: T,
  ): T => ({
    ...diff,
    added: diff.added.filter((added) => !isExcluded(entity, added.codename)),
    updated: new Map([...diff.updated].filter(([codename]) => !isExcluded(entity, codename))),
    deleted: new Set([...diff.deleted].filter((codename) => !isExcluded(entity, codename))),
  });

  return {
    model: {
      ...model,
      contentTypes: keepObject("contentTypes", model.contentTypes),
      contentTypeSnippets: keepObject("contentTypeSnippets", model.contentTypeSnippets),
      taxonomyGroups: keepObject("taxonomies", model.taxonomyGroups),
      spaces: keepObject("spaces", model.spaces),
      languages: keepObject("languages", model.languages),
      workflows: keepObject("workflows", model.workflows),
      collections: model.collections.filter((op) => {
        const codename =
          pathCodenames(op.path)[0] ?? (op.op === "addInto" ? codenameOf(op.value) : null);
        return codename === null || !isExcluded("collections", codename);
      }),
    },
    excluded: excluded.map((item) => ({
      entity: item.entity,
      codename: item.codename,
      kind: item.kind,
    })),
    conflicts,
  };
};
