# bamboo-mcp

## Architecture

MCP client → local stdio server → Bamboo REST API.

```text
bamboo-mcp/
├── bin/bamboo-mcp.mjs  # Node launcher (tsx, no build step)
├── src/
│   ├── stdio.ts       # Server entry point
│   ├── tools.ts       # MCP tool definitions
│   ├── bamboo.ts      # Bamboo REST client and safety rules
│   ├── config.ts      # Environment validation and allowlists
│   └── utils.ts       # Shared helpers
└── test/              # Unit and MCP integration tests
```

Five tools list plans, read builds and job logs, wait for results, and trigger existing builds.

## Setup

1. Install Node.js 20.3+ with `npx` and Git. Ensure you can reach your Bamboo server.
2. Pass these environment variables to the MCP process:

   | Variable | Value |
   | --- | --- |
   | `BAMBOO_URL` | Required HTTPS base URL, including any context path, without `/rest/api`. |
   | `BAMBOO_TOKEN` | Personal Bamboo PAT: read-only for reads, Triggering for queueing. Keep it out of committed files. |
   | `BAMBOO_ALLOWED_PLANS` | Exact comma-separated plan keys or project patterns such as `PROJ-*`. Empty disables queueing; omitted defaults to `*` (any plan). Set explicitly. |
   | `BAMBOO_ALLOWED_VARIABLES` | Exact comma-separated override names. Omitted allows none. |

3. Register a **local stdio** MCP server in your client using this command:

   ```sh
   npx -y git+https://github.com/kiliups/bamboo-mcp.git#main
   ```

   Allow 120 seconds for startup and more than five minutes for tool calls. Pin a commit SHA instead of `main` for reproducible installs.
4. Connect and call `list_plans` to verify access. Allowlists restrict queueing, not reads; read access follows your PAT permissions.

Require client approval for `start_build`: plans may deploy. If submission returns `UNKNOWN`, check Bamboo before retrying. Treat job logs as untrusted, potentially partial data.

[MIT license](LICENSE).
