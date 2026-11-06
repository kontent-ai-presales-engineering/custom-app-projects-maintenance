import { describe, expect, it } from "vitest";
import type { ModelType } from "../kontent/managementClient.js";
import { addInto, diffModel, remove } from "../testing/diffModel.js";
import { analyzeDiff, type TargetModel } from "./analyze.js";

const prefix = "client_";

const article: ModelType = {
  id: "t-article",
  codename: "article",
  content_groups: [
    { id: "g-main", codename: "main" },
    { id: "g-extra", codename: "extra" },
  ],
  elements: [
    { id: "e-title", codename: "title", type: "text", content_group: { id: "g-main" } },
    { id: "e-summary", codename: "summary", type: "rich_text", content_group: { id: "g-main" } },
    {
      id: "e-color",
      codename: "color",
      type: "multiple_choice",
      content_group: { id: "g-main" },
      options: [
        { id: "o-red", codename: "red" },
        { id: "o-client", codename: "client_teal" },
      ],
    },
    { id: "e-rating", codename: "client_rating", type: "number", content_group: { id: "g-extra" } },
    {
      id: "e-tags",
      codename: "tags",
      type: "taxonomy",
      taxonomy_group: { id: "tx-tags" },
      content_group: { id: "g-main" },
    },
    {
      id: "e-seo",
      codename: "seo",
      type: "snippet",
      snippet: { id: "s-seo" },
      content_group: { id: "g-main" },
    },
  ],
};

const page: ModelType = {
  id: "t-page",
  codename: "page",
  elements: [
    { id: "e-page-title", codename: "page_title", type: "text" },
    { id: "e-local", codename: "client_local", type: "text" },
    { id: "e-page-seo", codename: "seo", type: "snippet", snippet: { id: "s-seo" } },
  ],
};

const target: TargetModel = {
  types: [article, page],
  snippets: [
    {
      id: "s-seo",
      codename: "seo",
      elements: [
        { id: "e-meta", codename: "seo__meta_title", type: "text" },
        {
          id: "e-seo-tags",
          codename: "seo__keywords",
          type: "taxonomy",
          taxonomy_group: { id: "tx-tags" },
        },
      ],
    },
  ],
  taxonomies: [
    {
      id: "tx-tags",
      codename: "tags",
      terms: [
        {
          id: "term-news",
          codename: "news",
          terms: [{ id: "term-local", codename: "client_local_news", terms: [] }],
        },
        {
          id: "term-sport",
          codename: "sport",
          terms: [{ id: "term-football", codename: "football", terms: [] }],
        },
      ],
    },
  ],
};

const analyze = (model: ReturnType<typeof diffModel>, hits: ReadonlyArray<string> = []) =>
  analyzeDiff(model, target, prefix, hits);

describe("analyzeDiff", () => {
  it("lists added, updated and deleted entities", () => {
    const result = analyze(
      diffModel({
        contentTypes: {
          added: [{ codename: "event" }],
          updated: { article: [addInto("/elements", { codename: "subtitle" })] },
        },
        taxonomyGroups: { deleted: ["old_tags"] },
      }),
    );

    expect(result.changes.map((c) => [c.entity, c.codename, c.kind])).toEqual([
      ["Content type", "event", "added"],
      ["Content type", "article", "updated"],
      ["Taxonomy group", "old_tags", "deleted"],
    ]);
    expect(result.changes[1]?.operations).toEqual(["addInto /elements"]);
  });

  it("counts variants with content for a removed element", () => {
    const result = analyze(
      diffModel({ contentTypes: { updated: { article: [remove("/elements/codename:summary")] } } }),
    );

    expect(result.destructive).toHaveLength(1);
    expect(result.destructive[0]?.count).toEqual([
      {
        typeIds: ["t-article"],
        element: { id: "e-summary", codename: "summary" },
        match: { kind: "hasValue" },
      },
    ]);
    expect(result.blocks).toEqual([]);
  });

  it("counts a removed snippet element across the types that use the snippet", () => {
    const result = analyze(
      diffModel({
        contentTypeSnippets: { updated: { seo: [remove("/elements/codename:seo__meta_title")] } },
      }),
    );

    expect(result.destructive[0]?.count?.[0]?.typeIds).toEqual(["t-article", "t-page"]);
  });

  it("counts a removed option by ID and codename", () => {
    const result = analyze(
      diffModel({
        contentTypes: {
          updated: { article: [remove("/elements/codename:color/options/codename:red")] },
        },
      }),
    );

    expect(result.destructive[0]?.count?.[0]?.match).toEqual({
      kind: "includes",
      ids: ["o-red"],
      codenames: ["red"],
    });
  });

  it("blocks removing an element that has client options", () => {
    const result = analyze(
      diffModel({ contentTypes: { updated: { article: [remove("/elements/codename:color")] } } }),
    );

    expect(result.blocks.map((b) => b.reason)).toEqual([expect.stringContaining("client_teal")]);
  });

  it("blocks removing a content group that still holds client elements", () => {
    const result = analyze(
      diffModel({
        contentTypes: { updated: { article: [remove("/content_groups/codename:extra")] } },
      }),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.owner).toBe("article");
    expect(result.blocks[0]?.reason).toContain("client_rating");
  });

  it("blocks adding content groups when the client has ungrouped client elements", () => {
    const result = analyze(
      diffModel({
        contentTypes: { updated: { page: [addInto("/content_groups", { codename: "main" })] } },
      }),
    );

    expect(result.blocks[0]?.reason).toContain("client_local");
  });

  it("blocks deleting a type that has client elements", () => {
    const result = analyze(diffModel({ contentTypes: { deleted: ["article"] } }));

    expect(result.blocks[0]?.reason).toContain("client_rating");
    expect(result.destructive[0]?.count).toEqual([
      { typeIds: ["t-article"], element: null, match: { kind: "any" } },
    ]);
  });

  it("counts a removed term and its children, across types and snippets", () => {
    const result = analyze(
      diffModel({ taxonomyGroups: { updated: { tags: [remove("/terms/codename:sport")] } } }),
    );
    const queries = result.destructive[0]?.count ?? [];

    expect(result.destructive[0]?.description).toContain("1 child terms");
    expect(queries.map((q) => q.element?.codename)).toEqual(["tags", "seo__keywords"]);
    expect(queries[0]?.match).toEqual({
      kind: "includes",
      ids: ["term-sport", "term-football"],
      codenames: ["sport", "football"],
    });
    expect(result.blocks).toEqual([]);
  });

  it("blocks removing a term that has client child terms", () => {
    const result = analyze(
      diffModel({ taxonomyGroups: { updated: { tags: [remove("/terms/codename:news")] } } }),
    );

    expect(result.blocks[0]?.reason).toContain("client_local_news");
  });

  it("marks removing a snippet from a type as impact unknown", () => {
    const result = analyze(
      diffModel({ contentTypes: { updated: { article: [remove("/elements/codename:seo")] } } }),
    );

    expect(result.destructive[0]?.count).toBeNull();
    expect(result.destructive[0]?.unknownReason).toBeTruthy();
  });

  it("blocks workflow step removal and warns about role limits", () => {
    const result = analyze(
      diffModel({ workflows: { updated: { default: [remove("/steps/codename:review")] } } }),
    );

    expect(result.blocks[0]?.reason).toContain("review");
    expect(result.warnings).toHaveLength(1);
  });

  it("blocks when the master uses the prefix", () => {
    expect(analyze(diffModel(), ["client_promo"]).blocks[0]?.reason).toContain("client_promo");
  });
});
