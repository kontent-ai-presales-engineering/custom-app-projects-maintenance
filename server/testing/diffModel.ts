import type { DiffModel, PatchOperation } from "../sync/dataOps.js";

type Obj = Readonly<{
  added?: ReadonlyArray<Record<string, unknown>>;
  updated?: Readonly<Record<string, ReadonlyArray<PatchOperation>>>;
  deleted?: ReadonlyArray<string>;
}>;

const diffObject = (obj: Obj = {}) => ({
  added: (obj.added ?? []) as never[],
  updated: new Map(Object.entries(obj.updated ?? {})),
  deleted: new Set(obj.deleted ?? []),
});

/** Builds a data-ops DiffModel for tests, with everything empty unless given. */
export const diffModel = (
  parts: Readonly<{
    contentTypes?: Obj;
    contentTypeSnippets?: Obj;
    taxonomyGroups?: Obj;
    spaces?: Obj;
    languages?: Obj;
    workflows?: Obj;
    collections?: ReadonlyArray<PatchOperation>;
    assetFolders?: ReadonlyArray<PatchOperation>;
  }> = {},
): DiffModel => ({
  contentTypes: diffObject(parts.contentTypes),
  contentTypeSnippets: diffObject(parts.contentTypeSnippets),
  taxonomyGroups: diffObject(parts.taxonomyGroups),
  spaces: diffObject(parts.spaces),
  languages: { ...diffObject(parts.languages), inactiveTargetLanguageCodenames: new Set() },
  workflows: { ...diffObject(parts.workflows), sourceWorkflows: [] },
  collections: parts.collections ?? [],
  assetFolders: parts.assetFolders ?? [],
  livePreview: { change: "none" },
});

export const remove = (path: string): PatchOperation => ({ op: "remove", path, oldValue: null });
export const addInto = (path: string, value: unknown): PatchOperation => ({
  op: "addInto",
  path,
  value,
});
