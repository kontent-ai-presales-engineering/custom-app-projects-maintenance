import type { DiffModel, PatchOperation } from "./dataOps.js";

/**
 * Client-only additions use a reserved codename prefix. Snippet elements are named
 * "<snippet>__<element>", so for those the part after "__" is checked as well.
 */
export const isPrefixed = (codename: string, prefix: string): boolean => {
  if (codename.startsWith(prefix)) {
    return true;
  }
  const separator = codename.indexOf("__");
  return separator > 0 && codename.slice(separator + 2).startsWith(prefix);
};

/** Codenames named in a patch path, outermost first: "/elements/codename:a/options/codename:b" gives [a, b]. */
export const pathCodenames = (path: string): ReadonlyArray<string> =>
  path
    .split("/")
    .filter((part) => part.startsWith("codename:"))
    .map((part) => part.slice("codename:".length));

const removedCodename = (op: PatchOperation): string | null =>
  op.op === "remove" ? (pathCodenames(op.path).at(-1) ?? null) : null;

export type PrefixFilterResult = Readonly<{
  model: DiffModel;
  /** Human-readable list of what was dropped, for the report. */
  dropped: ReadonlyArray<string>;
}>;

/**
 * Removes every operation that would remove a client-only (prefixed) item from the
 * target. Only removals are dropped: the filter never adds or changes operations.
 */
export const dropPrefixedRemovals = (model: DiffModel, prefix: string): PrefixFilterResult => {
  const dropped: string[] = [];

  const keepOps = (entity: string, owner: string | null, ops: ReadonlyArray<PatchOperation>) =>
    ops.filter((op) => {
      const codename = removedCodename(op);
      if (codename !== null && isPrefixed(codename, prefix)) {
        dropped.push(`${entity}${owner === null ? "" : ` ${owner}`}: kept ${op.path}`);
        return false;
      }
      return true;
    });

  const filterObject = <
    T extends DiffModel[keyof DiffModel] & {
      updated: ReadonlyMap<string, ReadonlyArray<PatchOperation>>;
      deleted: ReadonlySet<string>;
    },
  >(
    entity: string,
    diff: T,
  ): T => {
    const deleted = new Set<string>();
    for (const codename of diff.deleted) {
      if (isPrefixed(codename, prefix)) {
        dropped.push(`${entity}: kept ${codename}`);
      } else {
        deleted.add(codename);
      }
    }
    const updated = new Map<string, ReadonlyArray<PatchOperation>>();
    for (const [codename, ops] of diff.updated) {
      const kept = keepOps(entity, codename, ops);
      if (kept.length > 0) {
        updated.set(codename, kept);
      }
    }
    return { ...diff, updated, deleted };
  };

  const filtered: DiffModel = {
    ...model,
    contentTypes: filterObject("Content type", model.contentTypes),
    contentTypeSnippets: filterObject("Snippet", model.contentTypeSnippets),
    taxonomyGroups: filterObject("Taxonomy group", model.taxonomyGroups),
    spaces: filterObject("Space", model.spaces),
    languages: filterObject("Language", model.languages),
    workflows: filterObject("Workflow", model.workflows),
    collections: keepOps("Collections", null, model.collections),
    assetFolders: keepOps("Asset folders", null, model.assetFolders),
  };

  return { model: filtered, dropped };
};

/**
 * Finds prefixed codenames the master would add to the client. The master may never
 * use the prefix, so any hit makes the diff invalid.
 *
 * Limitation: this inspects the diff, so a prefixed item that already exists
 * identically in the client is not detected.
 */
export const findPrefixInMaster = (model: DiffModel, prefix: string): ReadonlyArray<string> => {
  const hits = new Set<string>();

  const scanValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(scanValue);
      return;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.codename === "string" && isPrefixed(record.codename, prefix)) {
        hits.add(record.codename);
      }
      Object.values(record).forEach(scanValue);
    }
  };

  const scanOps = (ops: ReadonlyArray<PatchOperation>) => {
    for (const op of ops) {
      if (op.op === "addInto" || op.op === "replace") {
        scanValue(op.value);
      }
    }
  };

  for (const diff of [
    model.contentTypes,
    model.contentTypeSnippets,
    model.taxonomyGroups,
    model.spaces,
    model.languages,
    model.workflows,
  ]) {
    scanValue(diff.added);
    for (const ops of diff.updated.values()) {
      scanOps(ops);
    }
  }
  scanOps(model.collections);
  scanOps(model.assetFolders);

  return [...hits].sort();
};
