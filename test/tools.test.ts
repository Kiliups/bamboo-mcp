import { expect, spyOn, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Bamboo } from "../src/bamboo";
import { Config } from "../src/config";
import { BambooServer } from "../src/tools";
import { INVALID_ARGUMENTS } from "../src/utils";

const token = "synthetic-secret-marker";
const config = new Config({
  BAMBOO_URL: "https://bamboo.example.com",
  BAMBOO_ALLOWED_PLANS: "PROJ-PLAN",
});

test("MCP input validation never echoes keys/paths and preserves schemas/defaults", async () => {
  let calls = 0;
  const bamboo = new Bamboo(config, token, {
    fetch: async (url) => {
      calls++;
      expect(url.searchParams.get("start-index")).toBe("0");
      expect(url.searchParams.get("max-results")).toBe("20");
      return Response.json({ plans: { plan: [] } });
    },
  });
  const server = new BambooServer(bamboo).server;
  const client = new Client({ name: "validation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    for (const tool of tools)
      expect(tool.inputSchema.additionalProperties).toBe(false);

    for (const request of [
      { name: "list_plans", arguments: { [token]: true } },
      {
        name: "start_build",
        arguments: { plan_key: "PROJ-PLAN", variables: { [token]: 1 } },
      },
      { name: "get_build", arguments: {} },
      {
        name: "get_build",
        arguments: { plan_key: "PROJ-PLAN", result_key: "PROJ-PLAN-1" },
      },
      {
        name: "start_build",
        arguments: { plan_key: "PROJ-PLAN", revision: "refs//main" },
      },
    ]) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(INVALID_ARGUMENTS);
      expect(JSON.stringify(result)).not.toContain(token);
    }
    const capped = await client.callTool({
      name: "list_plans",
      arguments: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`${token}-${i}`, true]),
      ),
    });
    expect(capped.isError).toBe(true);
    expect(JSON.stringify(capped)).not.toContain(token);
    expect(calls).toBe(0);

    const result = await client.callTool({ name: "list_plans", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(calls).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP callback boundary redacts errors and hides non-Error throws", async () => {
  const bamboo = new Bamboo(config, token);
  const method = spyOn(bamboo, "listPlans");
  const server = new BambooServer(bamboo).server;
  const client = new Client({ name: "error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const { error, message } of [
      { error: new Error(`Failure: ${token}`), message: "Failure: [REDACTED]" },
      { error: token, message: "Bamboo tool failed." },
    ]) {
      method.mockRejectedValue(error);
      const result = await client.callTool({ name: "list_plans", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: message }]);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  } finally {
    method.mockRestore();
    await client.close();
    await server.close();
  }
});
