import { describe, expect, it, vi } from "vitest";
import { subscriptionUser } from "../testing/fixtures.js";
import { createSubscriptionClient, KontentApiError } from "./subscriptionClient.js";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const clientWith = (responses: ReadonlyArray<Response>) => {
  const queue = [...responses];
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
    Promise.resolve(queue.shift() ?? jsonResponse({}, 500)),
  );
  const sleep = vi.fn(async () => Promise.resolve());
  const client = createSubscriptionClient({
    subscriptionId: "sub-1",
    apiKey: "sub-key",
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep,
  });
  return { client, fetchFn, sleep };
};

describe("subscription client", () => {
  it("gets a user with GET and the bearer key", async () => {
    const { client, fetchFn } = clientWith([jsonResponse(subscriptionUser())]);

    const user = await client.getUser("user/1");

    expect(user?.email).toBe("ada@example.com");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://manage.kontent.ai/v2/subscriptions/sub-1/users/user%2F1");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sub-key");
  });

  it("returns null for an unknown user", async () => {
    const { client } = clientWith([jsonResponse({ message: "not found" }, 404)]);

    expect(await client.getUser("x")).toBeNull();
  });

  it("throws on other errors without including the key", async () => {
    const { client } = clientWith([jsonResponse({}, 401)]);

    const error = await client.getUser("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KontentApiError);
    expect((error as Error).message).not.toContain("sub-key");
  });

  it("retries 429 responses using Retry-After", async () => {
    const { client, sleep } = clientWith([
      jsonResponse({}, 429, { "retry-after": "3" }),
      jsonResponse(subscriptionUser()),
    ]);

    expect(await client.getUser("x")).not.toBeNull();
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("gives up after the retry limit", async () => {
    const { client } = clientWith([
      jsonResponse({}, 429),
      jsonResponse({}, 429),
      jsonResponse({}, 429),
      jsonResponse({}, 429),
    ]);

    await expect(client.getUser("x")).rejects.toMatchObject({ status: 429 });
  });

  it("follows continuation tokens when listing projects", async () => {
    const project = (id: string) => ({ id, name: id, is_active: true, environments: [] });
    const { client, fetchFn } = clientWith([
      jsonResponse({ projects: [project("a")], pagination: { continuation_token: "next" } }),
      jsonResponse({ projects: [project("b")], pagination: { continuation_token: null } }),
    ]);

    const projects = await client.listProjects();

    expect(projects.map((p) => p.id)).toEqual(["a", "b"]);
    const secondHeaders = fetchFn.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders["x-continuation"]).toBe("next");
  });

  it("only ever sends GET requests", async () => {
    const { client, fetchFn } = clientWith([
      jsonResponse(subscriptionUser()),
      jsonResponse({ projects: [] }),
    ]);
    await client.getUser("x");
    await client.listProjects();

    expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(Object.keys(client).sort()).toEqual(["getUser", "listProjects", "listUsers"]);
  });
});

describe("subscription client: users", () => {
  it("lists all users across pages", async () => {
    const { client, fetchFn } = clientWith([
      jsonResponse({ users: [subscriptionUser()], pagination: { continuation_token: "next" } }),
      jsonResponse({ users: [subscriptionUser()], pagination: { continuation_token: null } }),
    ]);

    expect(await client.listUsers()).toHaveLength(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://manage.kontent.ai/v2/subscriptions/sub-1/users",
    );
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
