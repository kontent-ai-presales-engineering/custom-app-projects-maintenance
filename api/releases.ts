import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const bodySchema = z.object({
  version: z.string().max(100),
  notes: z.string().max(10_000).default(""),
});

/**
 * GET /api/releases: master releases (most recent first) and what each client environment
 * was last synced from.
 * POST /api/releases { version, notes }: snapshots the master's content model as a release.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET", "POST"] },
  async (request, caller) => {
    const { releases } = getRuntime();
    if (request.method === "POST") {
      const { version, notes } = await readJson(request, bodySchema);
      return json(201, await releases.create(caller, version, notes));
    }
    const [list, clientReleases] = await Promise.all([releases.list(), releases.clientReleases()]);
    return json(200, { releases: list, clientReleases });
  },
);

export default { fetch: handler };
