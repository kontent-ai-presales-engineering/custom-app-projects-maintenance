import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AccessDeniedError, type AccessGuard, type Caller } from "./access/accessGuard.js";
import { ValidationError } from "./errors.js";
import { json, readJson, withAccess } from "./http.js";

const caller: Caller = {
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  roles: ["Project manager"],
};

const guardFor =
  (result: Caller | Error): (() => AccessGuard) =>
  () => ({
    check: async () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  });

const request = (method = "GET") => new Request("https://app.example/api/test", { method });

const ok = async () => Promise.resolve(json(200, { ok: true }));

describe("withAccess", () => {
  it("calls the handler with the checked caller", async () => {
    const handler = vi.fn(ok);
    const response = await withAccess(
      { guard: guardFor(caller) },
      { methods: ["GET"] },
      handler,
    )(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(handler).toHaveBeenCalledWith(expect.any(Request), caller);
  });

  it("returns the access error status and does not run the handler", async () => {
    const handler = vi.fn(ok);
    const response = await withAccess(
      { guard: guardFor(new AccessDeniedError(403, "role_not_allowed", "No")) },
      { methods: ["GET"] },
      handler,
    )(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "role_not_allowed", message: "No" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 405 for other methods before the access check", async () => {
    const guard = vi.fn(guardFor(caller));
    const response = await withAccess({ guard }, { methods: ["GET"] }, ok)(request("DELETE"));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(guard).not.toHaveBeenCalled();
  });

  it("returns safe error messages and hides internal ones", async () => {
    const log = vi.fn();
    const validation = await withAccess(
      { guard: guardFor(caller), log },
      { methods: ["GET"] },
      async () => Promise.reject(new ValidationError("bad input")),
    )(request());
    const internal = await withAccess(
      { guard: guardFor(caller), log },
      { methods: ["GET"] },
      async () => Promise.reject(new Error("key is abc123")),
    )(request());

    expect(validation.status).toBe(400);
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain("abc123");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the configuration is invalid", async () => {
    const response = await withAccess(
      {
        guard: () => {
          throw new Error("Invalid server configuration");
        },
        log: vi.fn(),
      },
      { methods: ["GET"] },
      ok,
    )(request());

    expect(response.status).toBe(500);
  });
});

describe("readJson", () => {
  const schema = z.object({ environmentId: z.string() });
  const post = (body: string) => new Request("https://app.example/api/x", { method: "POST", body });

  it("returns parsed data", async () => {
    expect(await readJson(post('{"environmentId":"e1"}'), schema)).toEqual({ environmentId: "e1" });
  });

  it.each([
    "not json",
    "{}",
    '{"environmentId":1}',
  ])("rejects %s with a validation error", async (body) => {
    await expect(readJson(post(body), schema)).rejects.toBeInstanceOf(ValidationError);
  });
});
