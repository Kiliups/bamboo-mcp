import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Bamboo } from "./bamboo";
import { Config } from "./config";
import { BambooServer } from "./tools";

try {
  const token = process.env.BAMBOO_TOKEN;
  if (!token)
    throw new Error("Set BAMBOO_TOKEN in the MCP client's environment.");

  const bamboo = new Bamboo(new Config(), token);
  const handle = serveStdio(() => new BambooServer(bamboo).server, {
    maxSubscriptions: 0,
    onerror: (error) => console.error(bamboo.redact(error.message)),
  });
  process.once("SIGINT", () => void handle.close());
  process.once("SIGTERM", () => void handle.close());
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "bamboo-mcp could not start; check configuration.",
  );
  process.exitCode = 1;
}
