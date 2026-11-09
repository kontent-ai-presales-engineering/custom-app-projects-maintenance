import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { accessSecret, masterEnvId, validEnv } from "./testing/fixtures.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(validEnv());

    expect(config.masterEnvironmentId).toBe(masterEnvId);
    expect(config.clientPrefix).toBe("client_");
    expect([...config.allowedRoles]).toEqual(["project-manager"]);
    expect(config.accessSecret).toBe(accessSecret);
  });

  it("parses roles and normalises the master environment ID", () => {
    const config = loadConfig(
      validEnv({
        ALLOWED_ROLES: "project-manager, role-123 ",
        KONTENT_MASTER_ENVIRONMENT_ID: masterEnvId.toUpperCase(),
        CLIENT_PREFIX: "ext_",
      }),
    );

    expect([...config.allowedRoles]).toEqual(["project-manager", "role-123"]);
    expect(config.masterEnvironmentId).toBe(masterEnvId);
    expect(config.clientPrefix).toBe("ext_");
  });

  it("rejects a short access secret", () => {
    expect(() => loadConfig(validEnv({ APP_ACCESS_SECRET: "short" }))).toThrow(
      /APP_ACCESS_SECRET: must be at least 32 characters/,
    );
  });

  it("rejects a master environment ID that is not a GUID", () => {
    expect(() => loadConfig(validEnv({ KONTENT_MASTER_ENVIRONMENT_ID: "abc" }))).toThrow(
      ConfigError,
    );
  });

  it("names missing variables without including any values", () => {
    const env = validEnv({ KONTENT_SUBSCRIPTION_API_KEY: undefined });
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("KONTENT_SUBSCRIPTION_API_KEY");
    expect(message).not.toContain(accessSecret);
  });
});
