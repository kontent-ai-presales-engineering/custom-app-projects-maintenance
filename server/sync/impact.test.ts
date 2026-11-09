import { describe, expect, it, vi } from "vitest";
import type { DeliveryClient, PublishedItem } from "../kontent/deliveryClient.js";
import type { ModelType, ModelVariant } from "../kontent/managementClient.js";
import type { DestructiveChange } from "./analyze.js";
import { countImpact, hasContent } from "./impact.js";

const types: ReadonlyArray<ModelType> = [
  { id: "t-article", codename: "article", elements: [] },
  { id: "t-page", codename: "page", elements: [] },
];
const languages = [
  { id: "l-en", codename: "en", is_active: true },
  { id: "l-nl", codename: "nl", is_active: true },
  { id: "l-old", codename: "old", is_active: false },
];

const variant = (values: Record<string, unknown>): ModelVariant => ({
  elements: Object.entries(values).map(([id, value]) => ({ element: { id }, value })),
});

const published = (values: Record<string, unknown>): PublishedItem => ({
  elements: Object.fromEntries(
    Object.entries(values).map(([codename, value]) => [codename, { type: "x", value }]),
  ),
});

const elementRemoval: DestructiveChange = {
  id: "d1",
  entity: "Content type",
  owner: "article",
  description: "Element summary removed",
  count: [
    {
      typeIds: ["t-article"],
      element: { id: "e-summary", codename: "summary" },
      match: { kind: "hasValue" },
    },
  ],
  unknownReason: null,
};

const setup = (
  options: Readonly<{
    variants?: Record<string, ReadonlyArray<ModelVariant>>;
    components?: ReadonlyArray<string>;
    publishedItems?: (type: string, language: string) => ReadonlyArray<PublishedItem>;
    delivery?: DeliveryClient | null;
  }> = {},
) => {
  const listVariantsOfType = vi.fn(async (typeId: string) =>
    Promise.resolve(options.variants?.[typeId] ?? []),
  );
  const isUsedAsComponent = vi.fn(async (typeId: string) =>
    Promise.resolve(options.components?.includes(typeId) ?? false),
  );
  const publishedItemsFn = vi.fn(
    async (type: string, language: string, _elements: ReadonlyArray<string>) =>
      Promise.resolve(options.publishedItems?.(type, language) ?? []),
  );
  const delivery =
    options.delivery === undefined ? { publishedItems: publishedItemsFn } : options.delivery;
  return {
    deps: { management: { listVariantsOfType, isUsedAsComponent }, delivery, types, languages },
    listVariantsOfType,
    publishedItemsFn,
  };
};

describe("hasContent", () => {
  it.each([
    [null, false],
    ["", false],
    ["  ", false],
    ["<p><br></p>", false],
    [[], false],
    ["text", true],
    [0, true],
    [[{ id: "x" }], true],
  ])("%j -> %s", (value, expected) => {
    expect(hasContent(value)).toBe(expected);
  });
});

describe("countImpact", () => {
  it("counts latest and published content for a removed element", async () => {
    const { deps, publishedItemsFn } = setup({
      variants: {
        "t-article": [
          variant({ "e-summary": "<p>Hi</p>" }),
          variant({ "e-summary": "<p><br></p>" }),
          variant({}),
        ],
      },
      publishedItems: (_type, language) =>
        language === "en"
          ? [published({ summary: "<p>Hi</p>" }), published({ summary: "" })]
          : [published({ summary: "<p>Hoi</p>" })],
    });

    const impact = await countImpact([elementRemoval], deps);

    expect(impact.get("d1")).toEqual({ latest: 1, published: 2, unknownReasons: [] });
    expect(publishedItemsFn.mock.calls.map((c) => c[1])).toEqual(["en", "nl"]);
    expect(publishedItemsFn.mock.calls[0]?.[2]).toEqual(["summary"]);
  });

  it("matches options and terms by ID (latest) and codename (published)", async () => {
    const change: DestructiveChange = {
      ...elementRemoval,
      count: [
        {
          typeIds: ["t-article"],
          element: { id: "e-color", codename: "color" },
          match: { kind: "includes", ids: ["o-red"], codenames: ["red"] },
        },
      ],
    };
    const { deps } = setup({
      variants: {
        "t-article": [
          variant({ "e-color": [{ id: "o-red" }] }),
          variant({ "e-color": [{ id: "o-blue" }] }),
        ],
      },
      publishedItems: (_t, language) =>
        language === "en" ? [published({ color: [{ codename: "red" }] })] : [],
    });

    expect((await countImpact([change], deps)).get("d1")).toMatchObject({
      latest: 1,
      published: 1,
    });
  });

  it("counts a variant once when several queries of one change match it", async () => {
    const change: DestructiveChange = {
      ...elementRemoval,
      count: [
        {
          typeIds: ["t-article"],
          element: { id: "e-a", codename: "a" },
          match: { kind: "hasValue" },
        },
        {
          typeIds: ["t-article"],
          element: { id: "e-b", codename: "b" },
          match: { kind: "hasValue" },
        },
      ],
    };
    const { deps } = setup({
      variants: { "t-article": [variant({ "e-a": "x", "e-b": "y" })] },
      delivery: null,
    });

    expect((await countImpact([change], deps)).get("d1")?.latest).toBe(1);
  });

  it("reads each type's variants once across changes", async () => {
    const { deps, listVariantsOfType } = setup();
    await countImpact([elementRemoval, { ...elementRemoval, id: "d2" }], deps);

    expect(listVariantsOfType).toHaveBeenCalledTimes(1);
  });

  it("reports unknown, never 0, when the type is used as a component", async () => {
    const { deps } = setup({ components: ["t-article"] });
    const impact = (await countImpact([elementRemoval], deps)).get("d1");

    expect(impact?.latest).toBeNull();
    expect(impact?.unknownReasons[0]).toContain("component");
  });

  it("reports published as unknown when the Delivery API is unavailable or refuses", async () => {
    const none = (await countImpact([elementRemoval], setup({ delivery: null }).deps)).get("d1");
    const refused = (
      await countImpact(
        [elementRemoval],
        setup({ delivery: { publishedItems: async () => Promise.reject(new Error("401")) } }).deps,
      )
    ).get("d1");

    expect(none).toMatchObject({ latest: 0, published: null });
    expect(refused?.published).toBeNull();
    expect(refused?.unknownReasons.join()).toContain("secure access");
  });

  it("keeps changes without a count query as unknown with their reason", async () => {
    const change: DestructiveChange = {
      ...elementRemoval,
      count: null,
      unknownReason: "Not counted yet.",
    };

    expect((await countImpact([change], setup().deps)).get("d1")).toEqual({
      latest: null,
      published: null,
      unknownReasons: ["Not counted yet."],
    });
  });
});
