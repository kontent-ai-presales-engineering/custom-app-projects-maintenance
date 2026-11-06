import { z } from "zod";
import {
  createGetter,
  type HttpOptions,
  KontentApiError,
  kontentApiBaseUrl,
} from "./kontentHttp.js";

const environmentInfoSchema = z.object({
  id: z.string(),
  /** The project name. */
  name: z.string(),
  /** The environment name. */
  environment: z.string(),
  is_production: z.boolean().optional(),
});

export type EnvironmentInfo = z.infer<typeof environmentInfoSchema>;

const reference = z.object({ id: z.string() });

const elementSchema = z.object({
  id: z.string(),
  codename: z.string().optional(),
  type: z.string(),
  content_group: reference.nullish(),
  options: z.array(z.object({ id: z.string(), codename: z.string().optional() })).optional(),
  taxonomy_group: reference.nullish(),
  snippet: reference.nullish(),
});

const typeSchema = z.object({
  id: z.string(),
  codename: z.string(),
  content_groups: z.array(z.object({ id: z.string(), codename: z.string() })).optional(),
  elements: z.array(elementSchema),
});

const snippetSchema = z.object({
  id: z.string(),
  codename: z.string(),
  elements: z.array(elementSchema),
});

type TermInput = { id: string; codename: string; terms: TermInput[] };
const termSchema: z.ZodType<TermInput> = z.lazy(() =>
  z.object({ id: z.string(), codename: z.string(), terms: z.array(termSchema) }),
);

const taxonomySchema = z.object({
  id: z.string(),
  codename: z.string(),
  terms: z.array(termSchema),
});

const languageSchema = z.object({
  id: z.string(),
  codename: z.string(),
  is_active: z.boolean(),
});

const variantSchema = z.object({
  elements: z.array(z.object({ element: reference, value: z.unknown() })),
});

export type ModelElement = z.infer<typeof elementSchema>;
export type ModelType = z.infer<typeof typeSchema>;
export type ModelSnippet = z.infer<typeof snippetSchema>;
export type ModelTaxonomy = z.infer<typeof taxonomySchema>;
export type ModelTerm = TermInput;
export type ModelLanguage = z.infer<typeof languageSchema>;
export type ModelVariant = z.infer<typeof variantSchema>;

/**
 * Management API client for one environment. Read-only: writes (backup restore, sync)
 * go through data-ops, not through this client.
 */
export type ManagementClient = Readonly<{
  getEnvironmentInfo: () => Promise<EnvironmentInfo>;
  /** Reads the first page of content types; succeeds only if the key may read the content model. */
  checkContentModelAccess: () => Promise<void>;
  listTypes: () => Promise<ReadonlyArray<ModelType>>;
  listSnippets: () => Promise<ReadonlyArray<ModelSnippet>>;
  listTaxonomies: () => Promise<ReadonlyArray<ModelTaxonomy>>;
  listLanguages: () => Promise<ReadonlyArray<ModelLanguage>>;
  /** Latest version of every language variant of the type. */
  listVariantsOfType: (typeId: string) => Promise<ReadonlyArray<ModelVariant>>;
  /** Whether any variant uses the type as a component inside rich text. */
  isUsedAsComponent: (typeId: string) => Promise<boolean>;
}>;

export type ManagementClientOptions = HttpOptions & Readonly<{ environmentId: string }>;

const continuationSchema = z.object({ continuation_token: z.string().nullable() }).nullish();

export const createManagementClient = (options: ManagementClientOptions): ManagementClient => {
  const root = `${kontentApiBaseUrl}/projects/${encodeURIComponent(options.environmentId)}`;
  const get = createGetter(options);

  const fail = (response: Response, what: string) =>
    new KontentApiError(
      response.status,
      `Management API ${what} failed with status ${response.status}`,
    );

  const getJson = async (path: string, what: string, headers: Record<string, string> = {}) => {
    const response = await get(`${root}${path}`, headers);
    if (!response.ok) {
      throw fail(response, what);
    }
    return (await response.json()) as unknown;
  };

  /** Follows x-continuation pagination and collects the items under `key`. */
  const listAll = async <T>(path: string, key: string, schema: z.ZodType<T>, what: string) => {
    const itemsSchema = z.array(schema);
    const items: T[] = [];
    let continuation: string | null = null;
    do {
      const page = z
        .record(z.string(), z.unknown())
        .parse(
          await getJson(
            path,
            what,
            continuation === null ? {} : { "x-continuation": continuation },
          ),
        );
      items.push(...itemsSchema.parse(page[key]));
      continuation = continuationSchema.parse(page.pagination)?.continuation_token ?? null;
    } while (continuation !== null);
    return items;
  };

  return {
    getEnvironmentInfo: async () =>
      environmentInfoSchema.parse(await getJson("", "environment lookup")),

    checkContentModelAccess: async () => {
      await getJson("/types", "content type listing");
    },

    listTypes: async () => await listAll("/types", "types", typeSchema, "content type listing"),
    listSnippets: async () =>
      await listAll("/snippets", "snippets", snippetSchema, "snippet listing"),
    listTaxonomies: async () =>
      await listAll("/taxonomies", "taxonomies", taxonomySchema, "taxonomy listing"),
    listLanguages: async () =>
      await listAll("/languages", "languages", languageSchema, "language listing"),

    listVariantsOfType: async (typeId) =>
      await listAll(
        `/types/${encodeURIComponent(typeId)}/variants`,
        "variants",
        variantSchema,
        "variant listing",
      ),

    isUsedAsComponent: async (typeId) => {
      const page = z
        .object({ variants: z.array(z.unknown()) })
        .parse(
          await getJson(`/types/${encodeURIComponent(typeId)}/components`, "component listing"),
        );
      return page.variants.length > 0;
    },
  };
};
