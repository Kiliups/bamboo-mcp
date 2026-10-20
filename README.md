# bamboo-mcp

Local stdio [MCP](https://modelcontextprotocol.io) server for existing Bamboo builds. Your agent client starts it with `npx`. The Bamboo token stays in the client's environment and is sent only to your Bamboo server.

It reads plans, builds and job logs, waits for a build, and queues a build of an allowlisted plan with allowlisted variable overrides.

## Requirements

- Node.js 20.3+ with `npx`.
- Network access to your Bamboo server, and Git access to the server repository.
- A personal Bamboo PAT. Do not use admin or "same as user" tokens.

## Command

```sh
npx -y git+https://github.com/kiliups/bamboo-mcp.git#main
```

`#main` is resolved again when `npx` starts, so new commits are picked up. For controlled rollouts, replace `main` with a commit SHA or an available tag.

The first run downloads dependencies and can be slow. Allow at least 120 seconds for client startup and more than five minutes for tool calls, since `wait_for_build` can wait that long.

## Client configuration

Register a local stdio MCP server in your client with command `npx` and arguments `-y` and `git+https://github.com/kiliups/bamboo-mcp.git#main`. Pass the environment variables below to that process. No client configuration files or credentials are included in this repository.

Use one token per server: a Triggering PAT if the client should queue builds, otherwise a read-only PAT. Set it in the shell that starts the client:

```sh
read -r -s BAMBOO_TOKEN && export BAMBOO_TOKEN
```

Set `BAMBOO_URL` to your server and explicitly restrict `BAMBOO_ALLOWED_PLANS` to the plans you want the client to queue. Set it to an empty string for read-only use.

## Configuration

| Variable                   | Meaning                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `BAMBOO_TOKEN`             | Required. Personal Bamboo PAT, supplied by the client.                                                                          |
| `BAMBOO_URL`               | Bamboo base URL, including any context path and without `/rest/api`. HTTPS required; HTTP only for loopback. No default.        |
| `BAMBOO_ALLOWED_PLANS`     | Exact, case-sensitive, comma-separated plan keys that `start_build` may queue. Default `*` (any plan). Empty disables queueing. |
| `BAMBOO_ALLOWED_VARIABLES` | Exact, comma-separated variable names that `start_build` may override. **Default: none.** Patterns and `*` are rejected.        |

URLs with credentials, query strings or fragments are rejected. Redirects from Bamboo are not followed.

### Variable overrides

Overrides are denied by default. To enable them, add the exact names of variables defined by your plans to `BAMBOO_ALLOWED_VARIABLES`. Any other override name is rejected before Bamboo is contacted.

## Tools

| Tool             | Arguments                                                                      | Result                                                                                       |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `list_plans`     | `start?` (0), `limit?` (20, max 100)                                           | Visible plan keys and names, local `can_start`, paging                                       |
| `get_build`      | Exactly one of `plan_key` (latest) or `result_key`                             | Key, state, lifecycle, revision, timing, job result keys, link                               |
| `wait_for_build` | `build_key`, `timeout_seconds?` (300, max 300)                                 | `succeeded` or `failed` once finished, or `timed_out` with the latest status if one was read |
| `get_job_log`    | `job_result_key`, `max_lines?` (100, max 200), `max_chars?` (12000, max 16000) | Bounded log text with truncation and partial-scope indicators                                |
| `start_build`    | `plan_key`, `revision?`, `variables?` (string map)                             | `queued` with build key, number and link                                                     |

Plan keys look like `PROJECT-PLAN`; job results like `PROJECT-PLAN-JOB-42`. Revisions accept hash, number and ref characters (`A-Z a-z 0-9 . _ / -`); Git expressions such as `HEAD~1` are rejected. Unknown fields are rejected.

## Safety

- Require client-side approval for `start_build`. MCP annotations are hints, not enforcement, and an allowlisted plan can still deploy.
- A queue request with an ambiguous outcome (timeout, network error, 408, 5xx, redirect, or an unexpected response) returns `Submission outcome UNKNOWN`. Bamboo may already have queued the build, so check Bamboo before retrying. There is no automatic retry.
- Reads follow the token's Bamboo permissions, not the allowlists.
- Log text comes from Bamboo, is untrusted data, and may be partial (REST `logEntries`). Use the Bamboo UI for large logs.
- Upstream requests time out after 15 seconds and responses are capped at 2 MiB. The token is redacted from tool output.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

The source is five modules: `src/config.ts` (environment), `src/bamboo.ts` (Bamboo client, validation and safety rules), `src/tools.ts` (MCP tools), `src/stdio.ts` (entry point) and `src/utils.ts` (shared helpers). `bin/bamboo-mcp.mjs` runs the TypeScript source with `tsx` under Node, so `npx` needs no build step.

Tests use a mocked Bamboo or a loopback fake server. Check the configuration against your Bamboo before rollout.

## License

MIT. See [LICENSE](LICENSE).
