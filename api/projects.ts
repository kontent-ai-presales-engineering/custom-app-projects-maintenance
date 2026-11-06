import { json, withAccess } from "../server/http.js";
import { getRuntime } from "../server/runtime.js";

/**
 * GET /api/projects: every project and environment in the subscription, with the
 * Management API key status per environment (never the key itself).
 */
const handler = withAccess({ guard: () => getRuntime().guard }, { methods: ["GET"] }, async () =>
  json(200, await getRuntime().projects.overview()),
);

export default { fetch: handler };
