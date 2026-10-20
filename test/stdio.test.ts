import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("launcher serves MCP over stdio under Node and queues only the allowlisted example override", async () => {
  const forms: string[] = [];
  const bamboo = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      forms.push(await request.text());
      return Response.json({ buildResultKey: "PROJ-PLAN-42", buildNumber: 42 });
    },
  });
  const client = new Client({ name: "bamboo-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [fileURLToPath(new URL("../bin/bamboo-mcp.mjs", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      BAMBOO_URL: bamboo.url.href,
      BAMBOO_TOKEN: "test-token",
      BAMBOO_ALLOWED_PLANS: "PROJ-PLAN",
      BAMBOO_ALLOWED_VARIABLES: "BUILD_LABEL",
    },
  });

  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "list_plans",
      "get_build",
      "wait_for_build",
      "get_job_log",
      "start_build",
    ]);
    const queued = await client.callTool({
      name: "start_build",
      arguments: {
        plan_key: "PROJ-PLAN",
        variables: { BUILD_LABEL: "example" },
      },
    });
    expect(queued.isError).not.toBe(true);
    const denied = await client.callTool({
      name: "start_build",
      arguments: { plan_key: "PROJ-PLAN", variables: { target: "dev" } },
    });
    expect(denied.isError).toBe(true);
    for (const arguments_ of [
      { plan_key: "PROJ-PLAN", "test-token": true },
      { plan_key: "PROJ-PLAN", variables: { "test-token": 1 } },
    ]) {
      const invalid = await client.callTool({
        name: "start_build",
        arguments: arguments_,
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("Invalid arguments");
      expect(JSON.stringify(invalid)).not.toContain("test-token");
    }
    expect(forms).toEqual(["bamboo.variable.BUILD_LABEL=example"]);
  } finally {
    await client.close();
    bamboo.stop(true);
  }
});
