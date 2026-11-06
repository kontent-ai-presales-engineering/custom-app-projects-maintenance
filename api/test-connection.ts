import { z } from "zod";
import { json, readJson, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

const bodySchema = z.object({
  environmentId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
});

/**
 * POST /api/test-connection { environmentId }: checks with read-only calls that the
 * configured Management API key works for the environment and can read the content model.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["POST"] },
  async (request) => {
    const { environmentId } = await readJson(request, bodySchema);
    return json(200, await getRuntime().projects.testConnection(environmentId));
  },
);

export default { fetch: handler };
