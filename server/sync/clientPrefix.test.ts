import { describe, expect, it } from "vitest";
import { addInto, diffModel, remove } from "../testing/diffModel.js";
import {
  dropPrefixedRemovals,
  findPrefixInMaster,
  isPrefixed,
  pathCodenames,
} from "./clientPrefix.js";

const prefix = "client_";

describe("isPrefixed", () => {
  it.each([
    ["client_extra", true],
    ["seo__client_extra", true],
    ["seo__meta_title", false],
    ["myclient_x", false],
    ["__client_x", false],
  ])("%s -> %s", (codename, expected) => {
    expect(isPrefixed(codename, prefix)).toBe(expected);
  });
});

describe("pathCodenames", () => {
  it("lists codenames outermost first", () => {
    expect(pathCodenames("/elements/codename:color/options/codename:red")).toEqual([
      "color",
      "red",
    ]);
    expect(pathCodenames("/name")).toEqual([]);
  });
});

describe("dropPrefixedRemovals", () => {
  it("drops removals of client items and keeps everything else", () => {
    const model = diffModel({
      contentTypes: {
        updated: {
          article: [
            remove("/elements/codename:client_rating"),
            remove("/elements/codename:old_field"),
            remove("/elements/codename:color/options/codename:client_teal"),
          ],
          page: [remove("/elements/codename:client_only")],
        },
        deleted: ["client_landing", "legacy"],
      },
      taxonomyGroups: {
        updated: { tags: [remove("/terms/codename:news/terms/codename:client_local")] },
      },
      collections: [remove("/codename:client_archive"), remove("/codename:old")],
    });

    const { model: filtered, dropped } = dropPrefixedRemovals(model, prefix);

    expect(filtered.contentTypes.updated.get("article")).toEqual([
      remove("/elements/codename:old_field"),
    ]);
    expect(filtered.contentTypes.updated.has("page")).toBe(false);
    expect([...filtered.contentTypes.deleted]).toEqual(["legacy"]);
    expect(filtered.taxonomyGroups.updated.size).toBe(0);
    expect(filtered.collections).toEqual([remove("/codename:old")]);
    expect(dropped).toHaveLength(6);
  });

  it("never adds or changes operations", () => {
    const add = addInto("/elements", { codename: "new_field" });
    const model = diffModel({ contentTypes: { updated: { article: [add] } } });

    expect(dropPrefixedRemovals(model, prefix).model.contentTypes.updated.get("article")).toEqual([
      add,
    ]);
  });
});

describe("findPrefixInMaster", () => {
  it("finds prefixed codenames the master would add", () => {
    const model = diffModel({
      contentTypes: {
        added: [{ codename: "client_promo", elements: [] }],
        updated: { article: [addInto("/elements", { codename: "client_badge", type: "text" })] },
      },
    });

    expect(findPrefixInMaster(model, prefix)).toEqual(["client_badge", "client_promo"]);
  });

  it("ignores prefixed codenames that only appear in removals", () => {
    const model = diffModel({
      contentTypes: { updated: { article: [remove("/elements/codename:client_x")] } },
    });

    expect(findPrefixInMaster(model, prefix)).toEqual([]);
  });
});
