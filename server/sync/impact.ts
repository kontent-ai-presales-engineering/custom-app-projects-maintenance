import type { DeliveryClient, PublishedItem } from "../kontent/deliveryClient.js";
import type {
  ManagementClient,
  ModelLanguage,
  ModelType,
  ModelVariant,
} from "../kontent/managementClient.js";
import type { CountQuery, DestructiveChange } from "./analyze.js";

/**
 * Impact of one destructive change. A count is a number only when it was actually
 * determined; otherwise it is null with a reason. Unknown is never shown as 0.
 */
export type Impact = Readonly<{
  latest: number | null;
  published: number | null;
  unknownReasons: ReadonlyArray<string>;
}>;

export type ImpactDeps = Readonly<{
  management: Pick<ManagementClient, "listVariantsOfType" | "isUsedAsComponent">;
  /** null when published counts cannot be read (for example secure access without a key). */
  delivery: DeliveryClient | null;
  types: ReadonlyArray<ModelType>;
  languages: ReadonlyArray<ModelLanguage>;
}>;

const emptyRichText = new Set(["<p><br></p>", "<p><br/></p>", "<p></p>"]);

/** Whether an element value holds content. Works for Management and Delivery values. */
export const hasContent = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && !emptyRichText.has(trimmed);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
};

const includesAny = (value: unknown, keys: ReadonlySet<string>, field: "id" | "codename") =>
  Array.isArray(value) &&
  value.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      keys.has(String((entry as Record<string, unknown>)[field])),
  );

const matchesLatest = (variant: ModelVariant, query: CountQuery): boolean => {
  if (query.element === null) {
    return true;
  }
  const elementId = query.element.id;
  const value = variant.elements.find((e) => e.element.id === elementId)?.value;
  switch (query.match.kind) {
    case "any":
      return true;
    case "hasValue":
      return hasContent(value);
    case "includes":
      return includesAny(value, new Set(query.match.ids), "id");
  }
};

const matchesPublished = (item: PublishedItem, query: CountQuery): boolean => {
  if (query.element === null) {
    return true;
  }
  const value = item.elements[query.element.codename]?.value;
  switch (query.match.kind) {
    case "any":
      return true;
    case "hasValue":
      return hasContent(value);
    case "includes":
      return includesAny(value, new Set(query.match.codenames), "codename");
  }
};

/**
 * Counts affected variants for each destructive change. Every type's variants are read
 * once, and published items once per type and language. A variant matching several
 * queries of the same change is counted once.
 */
export const countImpact = async (
  changes: ReadonlyArray<DestructiveChange>,
  deps: ImpactDeps,
): Promise<ReadonlyMap<string, Impact>> => {
  const typeById = new Map(deps.types.map((t) => [t.id, t]));
  const activeLanguages = deps.languages.filter((l) => l.is_active);

  const latestCache = new Map<string, Promise<ReadonlyArray<ModelVariant> | string>>();
  const latestFor = async (typeId: string) => {
    let cached = latestCache.get(typeId);
    if (cached === undefined) {
      cached = (async () => {
        if (await deps.management.isUsedAsComponent(typeId)) {
          return "The type is also used as a component in rich text, which is not counted.";
        }
        return await deps.management.listVariantsOfType(typeId);
      })().catch(() => "The Management API could not list the variants.");
      latestCache.set(typeId, cached);
    }
    return await cached;
  };

  // Elements needed per type for the published query, so each type is fetched once.
  const elementsPerType = new Map<string, Set<string>>();
  for (const change of changes) {
    for (const query of change.count ?? []) {
      for (const typeId of query.typeIds) {
        const set = elementsPerType.get(typeId) ?? new Set<string>();
        if (query.element !== null) {
          set.add(query.element.codename);
        }
        elementsPerType.set(typeId, set);
      }
    }
  }

  const publishedCache = new Map<string, Promise<ReadonlyArray<PublishedItem> | string>>();
  const publishedFor = async (typeId: string) => {
    let cached = publishedCache.get(typeId);
    if (cached === undefined) {
      const type = typeById.get(typeId);
      const delivery = deps.delivery;
      cached =
        type === undefined || delivery === null
          ? Promise.resolve(
              delivery === null
                ? "Published content cannot be read for this environment."
                : "The type was not found.",
            )
          : (async () => {
              const elements = [...(elementsPerType.get(typeId) ?? [])];
              const perLanguage = await Promise.all(
                activeLanguages.map(
                  async (language) =>
                    await delivery.publishedItems(type.codename, language.codename, elements),
                ),
              );
              return perLanguage.flat();
            })().catch(
              () =>
                "The Delivery API refused or failed. If secure access is enabled, add a Delivery API key.",
            );
      publishedCache.set(typeId, cached);
    }
    return await cached;
  };

  const result = new Map<string, Impact>();
  for (const change of changes) {
    if (change.count === null) {
      result.set(change.id, {
        latest: null,
        published: null,
        unknownReasons: [change.unknownReason ?? "Not counted."],
      });
      continue;
    }

    const reasons = new Set<string>();
    let latest: number | null = 0;
    let published: number | null = 0;

    // Group queries by type so a variant is counted once per change.
    const queriesByType = new Map<string, CountQuery[]>();
    for (const query of change.count) {
      for (const typeId of query.typeIds) {
        queriesByType.set(typeId, [...(queriesByType.get(typeId) ?? []), query]);
      }
    }

    for (const [typeId, queries] of queriesByType) {
      const variants = await latestFor(typeId);
      if (typeof variants === "string") {
        reasons.add(variants);
        latest = null;
      } else if (latest !== null) {
        latest += variants.filter((v) => queries.some((q) => matchesLatest(v, q))).length;
      }

      const items = await publishedFor(typeId);
      if (typeof items === "string") {
        reasons.add(items);
        published = null;
      } else if (published !== null) {
        published += items.filter((i) => queries.some((q) => matchesPublished(i, q))).length;
      }
    }

    result.set(change.id, { latest, published, unknownReasons: [...reasons] });
  }
  return result;
};
