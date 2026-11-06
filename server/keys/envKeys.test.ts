import { describe, expect, it } from "vitest";
import { clientEnvId, clientProjectId } from "../testing/fixtures.js";
import { keyVariableName, managementKeyStatus, resolveManagementKey } from "./envKeys.js";

const envVar = "KONTENT_MAPI_KEY_22222222_2222_2222_2222_222222222222";
const projectVar = "KONTENT_MAPI_KEY_33333333_3333_3333_3333_333333333333";

describe("management keys from environment variables", () => {
  it("builds the variable name from the ID", () => {
    expect(keyVariableName(clientEnvId)).toBe(envVar);
    expect(keyVariableName(` ${clientEnvId.toUpperCase()} `)).toBe(envVar);
  });

  it("prefers the environment key over the project key", () => {
    const env = { [envVar]: "env-key", [projectVar]: "project-key" };

    expect(
      resolveManagementKey(env, { environmentId: clientEnvId, projectId: clientProjectId }),
    ).toEqual({
      value: "env-key",
      source: "environment",
      variableName: envVar,
    });
  });

  it("falls back to the project key", () => {
    const env = { [projectVar]: " project-key " };

    expect(
      resolveManagementKey(env, { environmentId: clientEnvId, projectId: clientProjectId }),
    ).toEqual({
      value: "project-key",
      source: "project",
      variableName: projectVar,
    });
  });

  it("matches variable names case-insensitively", () => {
    const env = { [envVar.replace("KONTENT_MAPI_KEY_", "kontent_mapi_key_").toUpperCase()]: "k" };

    expect(resolveManagementKey(env, { environmentId: clientEnvId })?.value).toBe("k");
  });

  it("treats empty values as missing", () => {
    expect(resolveManagementKey({ [envVar]: "  " }, { environmentId: clientEnvId })).toBeNull();
  });

  it("reports status without the key value", () => {
    const configured = managementKeyStatus(
      { [envVar]: "secret-value" },
      { environmentId: clientEnvId },
    );
    const missing = managementKeyStatus(
      {},
      { environmentId: clientEnvId, projectId: clientProjectId },
    );

    expect(configured).toEqual({ configured: true, source: "environment", variableName: envVar });
    expect(JSON.stringify(configured)).not.toContain("secret-value");
    expect(missing).toEqual({ configured: false, source: null, variableName: envVar });
  });
});
