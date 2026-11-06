import { json, withAccess } from "../server/http.js";
import { managementKeyStatus } from "../server/keys/envKeys.js";
import { getRuntime } from "../server/runtime.js";

/**
 * GET /api/me: who the backend thinks the caller is (after the access check), and
 * whether the master environment's Management API key is configured.
 */
const handler = withAccess(
  { guard: () => getRuntime().guard },
  { methods: ["GET"] },
  async (_request, caller) => {
    const { config } = getRuntime();
    return await Promise.resolve(
      json(200, {
        user: { email: caller.email, name: caller.name, roles: caller.roles },
        master: {
          environmentId: config.masterEnvironmentId,
          key: managementKeyStatus(process.env, { environmentId: config.masterEnvironmentId }),
        },
      }),
    );
  },
);

export default { fetch: handler };
