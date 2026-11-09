import type {
  ModelElement,
  ModelSnippet,
  ModelTaxonomy,
  ModelTerm,
  ModelType,
} from "../kontent/managementClient.js";
import { isPrefixed, pathCodenames } from "./clientPrefix.js";
import type { DiffModel, PatchOperation } from "./dataOps.js";

/** The client's current model, read before analysing the diff. */
export type TargetModel = Readonly<{
  types: ReadonlyArray<ModelType>;
  snippets: ReadonlyArray<ModelSnippet>;
  taxonomies: ReadonlyArray<ModelTaxonomy>;
}>;

export type EntityLabel =
  | "Content type"
  | "Snippet"
  | "Taxonomy group"
  | "Collection"
  | "Space"
  | "Language"
  | "Workflow"
  | "Asset folder";

export type EntityChange = Readonly<{
  entity: EntityLabel;
  codename: string;
  kind: "added" | "updated" | "deleted";
  /** Operation summaries for updates, for example "remove /elements/codename:title". */
  operations: ReadonlyArray<string>;
}>;

/**
 * What to count for a destructive change: variants of the given types whose element
 * matches. `element: null` counts every variant of the types.
 */
export type CountQuery = Readonly<{
  typeIds: ReadonlyArray<string>;
  element: Readonly<{ id: string; codename: string }> | null;
  match:
    | Readonly<{ kind: "any" }>
    | Readonly<{ kind: "hasValue" }>
    | Readonly<{ kind: "includes"; ids: ReadonlyArray<string>; codenames: ReadonlyArray<string> }>;
}>;

export type DestructiveChange = Readonly<{
  id: string;
  entity: EntityLabel;
  owner: string;
  description: string;
  /** null when the impact cannot be counted (shown as "impact unknown"). */
  count: ReadonlyArray<CountQuery> | null;
  unknownReason: string | null;
}>;

export type Block = Readonly<{ entity: EntityLabel; owner: string; reason: string }>;

export type Warning = Readonly<{ entity: EntityLabel; owner: string; message: string }>;

export type Analysis = Readonly<{
  changes: ReadonlyArray<EntityChange>;
  destructive: ReadonlyArray<DestructiveChange>;
  blocks: ReadonlyArray<Block>;
  warnings: ReadonlyArray<Warning>;
}>;

const describeOp = (op: PatchOperation) => `${op.op} ${op.path}`;

const flattenTerms = (terms: ReadonlyArray<ModelTerm>): ReadonlyArray<ModelTerm> =>
  terms.flatMap((term) => [term, ...flattenTerms(term.terms)]);

const findTermByPath = (taxonomy: ModelTaxonomy, path: ReadonlyArray<string>) => {
  let terms: ReadonlyArray<ModelTerm> = taxonomy.terms;
  let found: ModelTerm | undefined;
  for (const codename of path) {
    found = terms.find((term) => term.codename === codename);
    if (found === undefined) {
      return undefined;
    }
    terms = found.terms;
  }
  return found;
};

export const analyzeDiff = (
  model: DiffModel,
  target: TargetModel,
  prefix: string,
  masterPrefixHits: ReadonlyArray<string>,
): Analysis => {
  const changes: EntityChange[] = [];
  const destructive: DestructiveChange[] = [];
  const blocks: Block[] = [];
  const warnings: Warning[] = [];
  let nextId = 0;
  const addDestructive = (change: Omit<DestructiveChange, "id">) => {
    nextId += 1;
    destructive.push({ id: `d${nextId}`, ...change });
  };

  const typeByCodename = new Map(target.types.map((t) => [t.codename, t]));
  const snippetByCodename = new Map(target.snippets.map((s) => [s.codename, s]));
  const taxonomyByCodename = new Map(target.taxonomies.map((t) => [t.codename, t]));

  /** Types that contain the snippet, directly. */
  const typesUsingSnippet = (snippetId: string) =>
    target.types.filter((t) =>
      t.elements.some((e) => e.type === "snippet" && e.snippet?.id === snippetId),
    );

  /** Element IDs and owning type IDs of taxonomy elements that use the group, including via snippets. */
  const taxonomyUsages = (groupId: string) => {
    const usages: Array<{ typeIds: ReadonlyArray<string>; element: ModelElement }> = [];
    for (const type of target.types) {
      for (const element of type.elements) {
        if (element.type === "taxonomy" && element.taxonomy_group?.id === groupId) {
          usages.push({ typeIds: [type.id], element });
        }
      }
    }
    for (const snippet of target.snippets) {
      const typeIds = typesUsingSnippet(snippet.id).map((t) => t.id);
      for (const element of snippet.elements) {
        if (element.type === "taxonomy" && element.taxonomy_group?.id === groupId) {
          usages.push({ typeIds, element });
        }
      }
    }
    return usages;
  };

  for (const hit of masterPrefixHits) {
    blocks.push({
      entity: "Content type",
      owner: hit,
      reason: `The master uses the reserved prefix "${prefix}" in "${hit}". Rename it in the master first.`,
    });
  }

  // Content types
  for (const added of model.contentTypes.added) {
    changes.push({
      entity: "Content type",
      codename: added.codename,
      kind: "added",
      operations: [],
    });
  }
  for (const codename of model.contentTypes.deleted) {
    changes.push({ entity: "Content type", codename, kind: "deleted", operations: [] });
    const type = typeByCodename.get(codename);
    const clientElements = type?.elements.filter((e) => isPrefixed(e.codename ?? "", prefix)) ?? [];
    if (clientElements.length > 0) {
      blocks.push({
        entity: "Content type",
        owner: codename,
        reason: `Deleting this type would remove project-specific elements (${clientElements.map((e) => e.codename).join(", ")}).`,
      });
    }
    addDestructive({
      entity: "Content type",
      owner: codename,
      description: `Content type "${codename}" is deleted from the sub-project.`,
      count:
        type === undefined ? null : [{ typeIds: [type.id], element: null, match: { kind: "any" } }],
      unknownReason:
        type === undefined ? "The type was not found in the sub-project's model." : null,
    });
  }
  for (const [codename, ops] of model.contentTypes.updated) {
    changes.push({
      entity: "Content type",
      codename,
      kind: "updated",
      operations: ops.map(describeOp),
    });
    const type = typeByCodename.get(codename);
    analyzeTypeOrSnippetOps(
      "Content type",
      codename,
      ops,
      type,
      type === undefined ? [] : [type.id],
    );

    // A master type that introduces content groups while the client has ungrouped client elements.
    const addsGroups = ops.some((op) => op.op === "addInto" && op.path === "/content_groups");
    const hadNoGroups = (type?.content_groups?.length ?? 0) === 0;
    const ungroupedClient =
      type?.elements.filter((e) => isPrefixed(e.codename ?? "", prefix)) ?? [];
    if (addsGroups && hadNoGroups && ungroupedClient.length > 0) {
      blocks.push({
        entity: "Content type",
        owner: codename,
        reason: `The master adds content groups, but the sub-project has elements outside any group (${ungroupedClient.map((e) => e.codename).join(", ")}). Put them in a group in the sub-project first.`,
      });
    }
  }

  // Snippets
  for (const added of model.contentTypeSnippets.added) {
    changes.push({ entity: "Snippet", codename: added.codename, kind: "added", operations: [] });
  }
  for (const codename of model.contentTypeSnippets.deleted) {
    changes.push({ entity: "Snippet", codename, kind: "deleted", operations: [] });
    const snippet = snippetByCodename.get(codename);
    const clientElements =
      snippet?.elements.filter((e) => isPrefixed(e.codename ?? "", prefix)) ?? [];
    if (clientElements.length > 0) {
      blocks.push({
        entity: "Snippet",
        owner: codename,
        reason: `Deleting this snippet would remove project-specific elements (${clientElements.map((e) => e.codename).join(", ")}).`,
      });
    }
    addDestructive({
      entity: "Snippet",
      owner: codename,
      description: `Snippet "${codename}" is deleted from the sub-project.`,
      count: null,
      unknownReason: "Content in deleted snippets is not counted yet.",
    });
  }
  for (const [codename, ops] of model.contentTypeSnippets.updated) {
    changes.push({ entity: "Snippet", codename, kind: "updated", operations: ops.map(describeOp) });
    const snippet = snippetByCodename.get(codename);
    analyzeTypeOrSnippetOps(
      "Snippet",
      codename,
      ops,
      snippet,
      snippet === undefined ? [] : typesUsingSnippet(snippet.id).map((t) => t.id),
    );
  }

  // Taxonomies
  for (const added of model.taxonomyGroups.added) {
    changes.push({
      entity: "Taxonomy group",
      codename: added.codename,
      kind: "added",
      operations: [],
    });
  }
  for (const codename of model.taxonomyGroups.deleted) {
    changes.push({ entity: "Taxonomy group", codename, kind: "deleted", operations: [] });
    const group = taxonomyByCodename.get(codename);
    const clientTerms = flattenTerms(group?.terms ?? []).filter((t) =>
      isPrefixed(t.codename, prefix),
    );
    if (clientTerms.length > 0) {
      blocks.push({
        entity: "Taxonomy group",
        owner: codename,
        reason: `Deleting this group would remove project-specific terms (${clientTerms.map((t) => t.codename).join(", ")}).`,
      });
    }
    addDestructive({
      entity: "Taxonomy group",
      owner: codename,
      description: `Taxonomy group "${codename}" is deleted from the sub-project.`,
      count:
        group === undefined
          ? null
          : taxonomyUsages(group.id).map((usage) => ({
              typeIds: usage.typeIds,
              element: { id: usage.element.id, codename: usage.element.codename ?? "" },
              match: { kind: "hasValue" as const },
            })),
      unknownReason:
        group === undefined ? "The group was not found in the sub-project's model." : null,
    });
  }
  for (const [codename, ops] of model.taxonomyGroups.updated) {
    changes.push({
      entity: "Taxonomy group",
      codename,
      kind: "updated",
      operations: ops.map(describeOp),
    });
    const group = taxonomyByCodename.get(codename);
    for (const op of ops) {
      if (op.op !== "remove") {
        continue;
      }
      const path = pathCodenames(op.path);
      const term = group === undefined ? undefined : findTermByPath(group, path);
      const removed = term === undefined ? [] : flattenTerms([term]);
      const clientTerms = removed.filter((t) => isPrefixed(t.codename, prefix));
      if (clientTerms.length > 0) {
        blocks.push({
          entity: "Taxonomy group",
          owner: codename,
          reason: `Removing term "${path.at(-1)}" would also remove project-specific terms (${clientTerms.map((t) => t.codename).join(", ")}).`,
        });
      }
      addDestructive({
        entity: "Taxonomy group",
        owner: codename,
        description: `Term "${path.at(-1)}"${removed.length > 1 ? ` and ${removed.length - 1} child terms` : ""} removed.`,
        count:
          group === undefined || term === undefined
            ? null
            : taxonomyUsages(group.id).map((usage) => ({
                typeIds: usage.typeIds,
                element: { id: usage.element.id, codename: usage.element.codename ?? "" },
                match: {
                  kind: "includes" as const,
                  ids: removed.map((t) => t.id),
                  codenames: removed.map((t) => t.codename),
                },
              })),
        unknownReason:
          group === undefined || term === undefined
            ? "The term was not found in the sub-project's model."
            : null,
      });
    }
  }

  // Collections and asset folders are lists of operations.
  for (const op of model.collections) {
    const codename = pathCodenames(op.path)[0] ?? op.path;
    changes.push({
      entity: "Collection",
      codename,
      kind: op.op === "remove" ? "deleted" : "updated",
      operations: [describeOp(op)],
    });
    if (op.op === "remove") {
      addDestructive({
        entity: "Collection",
        owner: codename,
        description: `Collection "${codename}" is removed. Removing a collection that still has items fails.`,
        count: null,
        unknownReason: "Items per collection are not counted yet.",
      });
    }
  }
  for (const op of model.assetFolders) {
    const codename = pathCodenames(op.path).at(-1) ?? op.path;
    changes.push({
      entity: "Asset folder",
      codename,
      kind: op.op === "remove" ? "deleted" : "updated",
      operations: [describeOp(op)],
    });
  }

  // Spaces
  for (const added of model.spaces.added) {
    changes.push({ entity: "Space", codename: added.codename, kind: "added", operations: [] });
  }
  for (const codename of model.spaces.deleted) {
    changes.push({ entity: "Space", codename, kind: "deleted", operations: [] });
    addDestructive({
      entity: "Space",
      owner: codename,
      description: `Space "${codename}" is deleted from the sub-project.`,
      count: null,
      unknownReason: "Items per space are not counted yet.",
    });
  }
  for (const [codename, ops] of model.spaces.updated) {
    changes.push({ entity: "Space", codename, kind: "updated", operations: ops.map(describeOp) });
  }

  // Languages: data-ops deactivates and renames instead of deleting.
  for (const added of model.languages.added) {
    changes.push({ entity: "Language", codename: added.codename, kind: "added", operations: [] });
  }
  for (const codename of model.languages.deleted) {
    changes.push({ entity: "Language", codename, kind: "deleted", operations: [] });
    addDestructive({
      entity: "Language",
      owner: codename,
      description: `Language "${codename}" is deactivated and renamed in the sub-project.`,
      count: null,
      unknownReason: "Variants per language are not counted yet.",
    });
  }
  for (const [codename, ops] of model.languages.updated) {
    changes.push({
      entity: "Language",
      codename,
      kind: "updated",
      operations: ops.map(describeOp),
    });
    if (ops.some((op) => op.op === "replace" && op.path === "/codename")) {
      addDestructive({
        entity: "Language",
        owner: codename,
        description: `The codename of language "${codename}" changes.`,
        count: null,
        unknownReason: "Variants per language are not counted yet.",
      });
    }
  }

  // Workflows
  if (
    model.workflows.added.length > 0 ||
    model.workflows.updated.size > 0 ||
    model.workflows.deleted.size > 0
  ) {
    warnings.push({
      entity: "Workflow",
      owner: "all",
      message: "Role limitations on workflow steps are not synced and are lost in the sub-project.",
    });
  }
  for (const added of model.workflows.added) {
    changes.push({ entity: "Workflow", codename: added.codename, kind: "added", operations: [] });
  }
  for (const codename of model.workflows.deleted) {
    changes.push({ entity: "Workflow", codename, kind: "deleted", operations: [] });
    blocks.push({
      entity: "Workflow",
      owner: codename,
      reason:
        "Deleting a workflow is blocked until the effect on variants in its steps has been tested on a sandbox.",
    });
  }
  for (const [codename, ops] of model.workflows.updated) {
    changes.push({
      entity: "Workflow",
      codename,
      kind: "updated",
      operations: ops.map(describeOp),
    });
    for (const op of ops) {
      if (op.op === "remove" && op.path.startsWith("/steps/")) {
        blocks.push({
          entity: "Workflow",
          owner: codename,
          reason: `Removing step "${pathCodenames(op.path).at(-1)}" is blocked until the effect on variants in that step has been tested on a sandbox.`,
        });
      }
    }
  }

  return { changes, destructive, blocks, warnings };

  function analyzeTypeOrSnippetOps(
    entity: "Content type" | "Snippet",
    owner: string,
    ops: ReadonlyArray<PatchOperation>,
    current: ModelType | ModelSnippet | undefined,
    countTypeIds: ReadonlyArray<string>,
  ) {
    const elementByCodename = new Map((current?.elements ?? []).map((e) => [e.codename, e]));
    const groups =
      current !== undefined && "content_groups" in current ? (current.content_groups ?? []) : [];

    for (const op of ops) {
      if (op.op !== "remove") {
        continue;
      }
      const path = pathCodenames(op.path);

      if (op.path.startsWith("/content_groups/")) {
        const group = groups.find((g) => g.codename === path[0]);
        const clientElements =
          group === undefined
            ? []
            : (current?.elements ?? []).filter(
                (e) => e.content_group?.id === group.id && isPrefixed(e.codename ?? "", prefix),
              );
        if (clientElements.length > 0) {
          blocks.push({
            entity,
            owner,
            reason: `Content group "${path[0]}" is removed but still contains project-specific elements (${clientElements.map((e) => e.codename).join(", ")}). Move or remove those elements first.`,
          });
        }
        continue;
      }

      if (!op.path.startsWith("/elements/")) {
        continue;
      }
      const element = elementByCodename.get(path[0]);
      if (element?.type === "snippet" && path.length === 1) {
        addDestructive({
          entity,
          owner,
          description: `Snippet "${path[0]}" is removed from this type.`,
          count: null,
          unknownReason: "Content in the snippet's elements is not counted yet.",
        });
        continue;
      }
      const unknown = element === undefined || countTypeIds.length === 0;

      if (path.length === 1) {
        const clientOptions = (element?.options ?? []).filter((o) =>
          isPrefixed(o.codename ?? "", prefix),
        );
        if (clientOptions.length > 0) {
          blocks.push({
            entity,
            owner,
            reason: `Removing element "${path[0]}" would also remove project-specific options (${clientOptions.map((o) => o.codename).join(", ")}).`,
          });
        }
        addDestructive({
          entity,
          owner,
          description: `Element "${path[0]}" is removed.`,
          count: unknown
            ? null
            : [
                {
                  typeIds: countTypeIds,
                  element: { id: element.id, codename: element.codename ?? path[0] ?? "" },
                  match: { kind: "hasValue" },
                },
              ],
          unknownReason: unknown
            ? "The element or the types using it were not found in the sub-project's model."
            : null,
        });
      } else if (op.path.includes("/options/")) {
        const option = element?.options?.find((o) => o.codename === path.at(-1));
        addDestructive({
          entity,
          owner,
          description: `Option "${path.at(-1)}" is removed from element "${path[0]}".`,
          count:
            unknown || option === undefined
              ? null
              : [
                  {
                    typeIds: countTypeIds,
                    element: { id: element.id, codename: element.codename ?? path[0] ?? "" },
                    match: {
                      kind: "includes",
                      ids: [option.id],
                      codenames: [option.codename ?? ""],
                    },
                  },
                ],
          unknownReason:
            unknown || option === undefined
              ? "The option was not found in the sub-project's model."
              : null,
        });
      }
    }
  }
};
