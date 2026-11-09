import { describe, expect, it } from "vitest";
import { addInto, diffModel, remove } from "../testing/diffModel.js";
import { excludeItems, findReferences, itemsSchema, restrictToItems } from "./selection.js";

describe("findReferences", () => {
  it("finds snippet, taxonomy, type and collection references", () => {
    const refs = findReferences({
      codename: "article",
      elements: [
        { codename: "seo", type: "snippet", snippet: { codename: "seo_meta" } },
        { codename: "tags", type: "taxonomy", taxonomy_group: { codename: "topics" } },
        {
          codename: "related",
          type: "modular_content",
          allowed_content_types: [{ codename: "page" }],
        },
      ],
    });

    expect(refs).toEqual([
      { entity: "contentTypeSnippets", codename: "seo_meta" },
      { entity: "taxonomies", codename: "topics" },
      { entity: "contentTypes", codename: "page" },
    ]);
  });

  it("does not treat an element's own codename as a reference", () => {
    expect(findReferences({ codename: "article", elements: [{ codename: "seo_meta" }] })).toEqual(
      [],
    );
  });
});

describe("restrictToItems", () => {
  const model = diffModel({
    contentTypes: {
      added: [
        {
          codename: "event",
          elements: [{ codename: "seo", type: "snippet", snippet: { codename: "seo_meta" } }],
        },
        { codename: "page", elements: [] },
      ],
      updated: {
        article: [
          addInto("/elements", {
            codename: "topic",
            type: "taxonomy",
            taxonomy_group: { codename: "topics" },
          }),
        ],
        news: [remove("/elements/codename:legacy_tags")],
      },
      deleted: ["old_type"],
    },
    contentTypeSnippets: {
      added: [{ codename: "seo_meta", elements: [] }],
      deleted: ["legacy_snippet"],
    },
    taxonomyGroups: { added: [{ codename: "topics", terms: [] }], deleted: ["old_tags"] },
  });

  it("returns the diff unchanged without a selection", () => {
    expect(restrictToItems(model, {})).toEqual({ model, dependencies: [] });
  });

  it("keeps only chosen items of restricted entities and whole other entities", () => {
    const { model: restricted, dependencies } = restrictToItems(model, { contentTypes: ["page"] });

    expect(restricted.contentTypes.added.map((t) => t.codename)).toEqual(["page"]);
    expect(restricted.contentTypes.updated.size).toBe(0);
    expect(restricted.contentTypes.deleted.size).toBe(0);
    // Not restricted: synced whole.
    expect(restricted.contentTypeSnippets.added.map((s) => s.codename)).toEqual(["seo_meta"]);
    expect(dependencies).toEqual([]);
  });

  it("includes new items that a chosen item uses", () => {
    const { model: restricted, dependencies } = restrictToItems(model, {
      contentTypes: ["event", "article"],
      contentTypeSnippets: [],
      taxonomies: [],
    });

    expect(restricted.contentTypeSnippets.added.map((s) => s.codename)).toEqual(["seo_meta"]);
    expect(restricted.taxonomyGroups.added.map((t) => t.codename)).toEqual(["topics"]);
    expect([...restricted.taxonomyGroups.deleted]).toEqual([]);
    expect(dependencies).toEqual([
      {
        entity: "contentTypeSnippets",
        codename: "seo_meta",
        reason: 'used by content type "event"',
      },
      { entity: "taxonomies", codename: "topics", reason: 'used by content type "article"' },
    ]);
  });

  it("includes the updates that stop using a chosen deletion", () => {
    const withUsage = diffModel({
      contentTypes: {
        updated: {
          news: [
            {
              op: "remove",
              path: "/elements/codename:tags",
              oldValue: {
                codename: "tags",
                type: "taxonomy",
                taxonomy_group: { codename: "old_tags" },
              },
            },
          ],
          article: [remove("/elements/codename:unrelated")],
        },
      },
      taxonomyGroups: { deleted: ["old_tags"] },
    });

    const { model: restricted, dependencies } = restrictToItems(withUsage, {
      taxonomies: ["old_tags"],
      contentTypes: [],
    });

    expect([...restricted.contentTypes.updated.keys()]).toEqual(["news"]);
    expect(dependencies).toEqual([
      {
        entity: "contentTypes",
        codename: "news",
        reason: 'stops using taxonomy group "old_tags", which is deleted',
      },
    ]);
  });

  it("follows dependencies transitively", () => {
    const chain = diffModel({
      contentTypes: {
        added: [
          {
            codename: "a",
            elements: [{ type: "modular_content", allowed_content_types: [{ codename: "b" }] }],
          },
          { codename: "b", elements: [{ type: "snippet", snippet: { codename: "s" } }] },
        ],
      },
      contentTypeSnippets: { added: [{ codename: "s", elements: [] }] },
    });

    const { dependencies } = restrictToItems(chain, {
      contentTypes: ["a"],
      contentTypeSnippets: [],
    });

    expect(dependencies.map((d) => d.codename)).toEqual(["b", "s"]);
  });

  it("never adds or changes operations", () => {
    const { model: restricted } = restrictToItems(model, { contentTypes: ["article"] });

    expect(restricted.contentTypes.updated.get("article")).toBe(
      model.contentTypes.updated.get("article"),
    );
  });
});

describe("itemsSchema", () => {
  it("accepts codename lists per entity and rejects unknown entities", () => {
    expect(itemsSchema.safeParse({ contentTypes: ["article"] }).success).toBe(true);
    expect(itemsSchema.safeParse({ assetFolders: ["x"] }).success).toBe(false);
    expect(itemsSchema.safeParse({ contentTypes: [""] }).success).toBe(false);
  });
});

describe("excludeItems", () => {
  it("drops every change to excluded items and lists them", () => {
    const model = diffModel({
      contentTypes: {
        updated: {
          article: [remove("/elements/codename:x")],
          page: [remove("/elements/codename:y")],
        },
        deleted: ["legacy"],
      },
    });

    const result = excludeItems(model, { contentTypes: ["article", "legacy"] });

    expect([...result.model.contentTypes.updated.keys()]).toEqual(["page"]);
    expect(result.model.contentTypes.deleted.size).toBe(0);
    expect(result.excluded).toEqual([
      { entity: "contentTypes", codename: "article", kind: "updated" },
      { entity: "contentTypes", codename: "legacy", kind: "deleted" },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports a conflict, not an inclusion, when a synced item needs an excluded new item", () => {
    const model = diffModel({
      contentTypes: {
        added: [{ codename: "event", elements: [{ snippet: { codename: "seo" } }] }],
      },
      contentTypeSnippets: { added: [{ codename: "seo", elements: [] }] },
    });

    const result = excludeItems(model, { contentTypeSnippets: ["seo"] });

    expect(result.model.contentTypeSnippets.added).toEqual([]);
    expect(result.model.contentTypes.added.map((t) => t.codename)).toEqual(["event"]);
    expect(result.conflicts).toEqual([
      {
        entity: "contentTypes",
        codename: "event",
        reason:
          'content type "event" uses snippet "seo", which is new in the master but excluded for this client',
      },
    ]);
  });

  it("reports a conflict when a deletion needs an excluded update", () => {
    const model = diffModel({
      contentTypes: {
        updated: {
          news: [
            {
              op: "remove",
              path: "/elements/codename:tags",
              oldValue: { taxonomy_group: { codename: "old_tags" } },
            },
          ],
        },
      },
      taxonomyGroups: { deleted: ["old_tags"] },
    });

    const result = excludeItems(model, { contentTypes: ["news"] });

    expect(result.conflicts.map((c) => c.codename)).toEqual(["old_tags"]);
  });

  it("returns the model unchanged without exclusions", () => {
    const model = diffModel({ contentTypes: { deleted: ["legacy"] } });

    expect(excludeItems(model, {}).model).toBe(model);
  });
});
