import { describe, expect, it, vi } from "vitest";
import { clientEnvId } from "../testing/fixtures.js";
import { KontentApiError } from "./kontentHttp.js";
import { createManagementClient } from "./managementClient.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const clientWith = (responses: ReadonlyArray<Response>) => {
  const queue = [...responses];
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
    Promise.resolve(queue.shift() ?? jsonResponse({}, 500)),
  );
  const client = createManagementClient({
    environmentId: clientEnvId,
    apiKey: "mapi-key",
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep: async () => Promise.resolve(),
  });
  return { client, fetchFn };
};

describe("management client", () => {
  it("reads environment information with GET", async () => {
    const { client, fetchFn } = clientWith([
      jsonResponse({
        id: clientEnvId,
        name: "Client A",
        environment: "Production",
        is_production: true,
      }),
    ]);

    expect(await client.getEnvironmentInfo()).toEqual({
      id: clientEnvId,
      name: "Client A",
      environment: "Production",
      is_production: true,
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`https://manage.kontent.ai/v2/projects/${clientEnvId}`);
    expect(init?.method).toBe("GET");
  });

  it("checks content model access on the types endpoint", async () => {
    const { client, fetchFn } = clientWith([jsonResponse({ types: [] })]);

    await client.checkContentModelAccess();
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://manage.kontent.ai/v2/projects/${clientEnvId}/types`,
    );
  });

  it("throws KontentApiError with the status and without the key", async () => {
    const { client } = clientWith([jsonResponse({}, 401)]);

    const error = await client.getEnvironmentInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KontentApiError);
    expect((error as KontentApiError).status).toBe(401);
    expect((error as Error).message).not.toContain("mapi-key");
  });
});
