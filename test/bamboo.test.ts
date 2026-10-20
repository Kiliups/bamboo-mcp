import { describe, expect, test } from "bun:test";
import { Bamboo, inputs } from "../src/bamboo";
import { Config } from "../src/config";

const env = {
  BAMBOO_URL: "https://bamboo.example.com/bamboo/",
  BAMBOO_TOKEN: "fake-test-token",
  BAMBOO_ALLOWED_PLANS: "PROJ-PLAN, PROJ-BRANCH1",
  BAMBOO_ALLOWED_VARIABLES: "target,version",
};
const config = new Config(env);
const queued = { buildResultKey: "PROJ-PLAN-42", buildNumber: 42 };
const response = (data: unknown, status = 200) =>
  Response.json(data, { status });

describe("configuration and validation", () => {
  test("context path and exact allowlists", () => {
    expect(config.url).toBe("https://bamboo.example.com/bamboo");
    expect([...config.allowedPlans]).toEqual(["PROJ-PLAN", "PROJ-BRANCH1"]);
    expect(
      new Config({ ...env, BAMBOO_ALLOWED_PLANS: "" }).allowedPlans.size,
    ).toBe(0);
  });
  test("bare * allows every plan; variables accept exact names only", () => {
    expect(
      new Config({ ...env, BAMBOO_ALLOWED_PLANS: "*" }).allowAllPlans,
    ).toBe(true);
    expect(config.allowAllPlans).toBe(false);
    expect(() => new Config({ ...env, BAMBOO_ALLOWED_VARIABLES: "*" })).toThrow(
      "invalid entry",
    );
    expect(
      () => new Config({ ...env, BAMBOO_ALLOWED_VARIABLES: "RUN_*" }),
    ).toThrow("invalid entry");
  });
  test("no variable overrides are allowed by default", async () => {
    const defaults = new Config({
      ...env,
      BAMBOO_ALLOWED_VARIABLES: undefined,
    });
    expect(defaults.allowedVariables.size).toBe(0);
    let calls = 0;
    const api = new Bamboo(defaults, env.BAMBOO_TOKEN, {
      fetch: async () => {
        calls++;
        return response(queued);
      },
    });
    await expect(
      api.startBuild({
        plan_key: "PROJ-PLAN",
        variables: { BUILD_LABEL: "example" },
      }),
    ).rejects.toThrow("BAMBOO_ALLOWED_VARIABLES");
    expect(calls).toBe(0);
    expect(await api.startBuild({ plan_key: "PROJ-PLAN" })).toMatchObject({
      outcome: "queued",
    });
    expect(calls).toBe(1);
  });
  test("example allowlist permits only the BUILD_LABEL override", async () => {
    const example = new Config({
      ...env,
      BAMBOO_ALLOWED_VARIABLES: "BUILD_LABEL",
    });
    const api = new Bamboo(example, env.BAMBOO_TOKEN, {
      fetch: async () => response(queued),
    });
    expect(
      await api.startBuild({
        plan_key: "PROJ-PLAN",
        variables: { BUILD_LABEL: "example" },
      }),
    ).toMatchObject({ outcome: "queued" });
    await expect(
      api.startBuild({ plan_key: "PROJ-PLAN", variables: { target: "dev" } }),
    ).rejects.toThrow("BAMBOO_ALLOWED_VARIABLES");
  });
  test("BAMBOO_URL is required; there is no default Bamboo", () => {
    for (const url of [undefined, ""]) {
      expect(() => new Config({ ...env, BAMBOO_URL: url })).toThrow(
        "BAMBOO_URL is required",
      );
    }
  });
  test("reject unsafe URLs and malformed configuration without echoing secrets", () => {
    for (const url of [
      "http://bamboo.example.com",
      "https://user:secret@example.com",
      "https://example.com?token=secret",
      "https://example.com/#secret",
      "file:///etc/hosts",
      "not a URL",
    ]) {
      expect(() => new Config({ ...env, BAMBOO_URL: url })).toThrow(
        "BAMBOO_URL",
      );
    }
    for (const url of [
      "http://localhost:8085/bamboo",
      "http://127.0.0.1:8085",
      "http://[::1]:8085",
    ]) {
      expect(new Config({ ...env, BAMBOO_URL: url }).url).toBe(url);
    }
    expect(
      new Config({ ...env, BAMBOO_TOKEN: "must-not-be-captured" }),
    ).not.toHaveProperty("token");
    expect(
      () => new Config({ ...env, BAMBOO_ALLOWED_PLANS: "PROJ-*" }),
    ).toThrow("invalid entry");
    expect(
      () => new Config({ ...env, BAMBOO_ALLOWED_VARIABLES: "target," }),
    ).toThrow("invalid entry");
  });
  test("reject unallowlisted mutations, malformed keys/revisions and unknown arguments before fetching", async () => {
    let calls = 0;
    const api = new Bamboo(config, env.BAMBOO_TOKEN, {
      fetch: async () => {
        calls++;
        return response(queued);
      },
    });
    for (const args of [
      { plan_key: "PROJ-OTHER" },
      { plan_key: "PROJ-PLAN", variables: { other: "x" } },
      { plan_key: "../PROJ-PLAN" },
      { plan_key: "PROJ-PLAN-JOB" },
      ...[
        "",
        "../main",
        "refs//main",
        "main\n",
        "main?x=1",
        "HEAD~1",
        "-main",
        "main/",
      ].map((revision) => ({ plan_key: "PROJ-PLAN", revision })),
      { plan_key: "PROJ-PLAN", executeAllStages: true },
      { plan_key: "PROJ-PLAN", stage: "Deploy" },
      { plan_key: "PROJ-PLAN", confirmed: true },
      { plan_key: "PROJ-PLAN", url: "https://elsewhere" },
      { plan_key: "PROJ-PLAN", variables: { target: 1 } },
      { plan_key: "PROJ-PLAN", variables: { target: "x".repeat(4097) } },
    ])
      await expect(api.startBuild(args)).rejects.toThrow();
    const readonly = new Bamboo(
      new Config({ ...env, BAMBOO_ALLOWED_PLANS: "" }),
      env.BAMBOO_TOKEN,
      {
        fetch: async () => {
          calls++;
          return response(queued);
        },
      },
    );
    await expect(
      readonly.startBuild({ plan_key: "PROJ-PLAN" }),
    ).rejects.toThrow("BAMBOO_ALLOWED_PLANS");
    for (const args of [
      {},
      { plan_key: "PROJ-PLAN", result_key: "PROJ-PLAN-1" },
      { result_key: "PROJ-PLAN-0" },
    ]) {
      await expect(api.getBuild(args)).rejects.toThrow("Invalid arguments");
    }
    await expect(
      api.getJobLog({ job_result_key: "PROJ-PLAN-42" }),
    ).rejects.toThrow("Invalid arguments");
    await expect(api.listPlans({ unknown: true })).rejects.toThrow(
      "Invalid arguments",
    );
    await expect(
      api.waitForBuild({ build_key: "PROJ-PLAN-42", unknown: true }),
    ).rejects.toThrow("Invalid arguments");
    expect(calls).toBe(0);
  });
});

test("queue contract: context path, revision query, form-encoded overrides, auth and no redirects", async () => {
  let calls = 0;
  const api = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async (url, init) => {
      calls++;
      expect(url.origin).toBe("https://bamboo.example.com");
      expect(url.pathname).toBe("/bamboo/rest/api/latest/queue/PROJ-PLAN");
      expect([...url.searchParams]).toEqual([
        ["customRevision", "refs/heads/feature-fix"],
      ]);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        `Bearer ${env.BAMBOO_TOKEN}`,
      );
      expect(new Headers(init.headers).get("Content-Type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(
        new URLSearchParams(String(init.body)).get("bamboo.variable.target"),
      ).toBe("dev & qa=+ü");
      expect(String(init.body)).toContain("dev+%26+qa%3D%2B%C3%BC");
      expect(url.searchParams.has("bamboo.variable.target")).toBe(false);
      return response({
        ...queued,
        link: { href: "https://untrusted.invalid/" },
      });
    },
  });
  expect(
    await api.startBuild({
      plan_key: "PROJ-PLAN",
      revision: "refs/heads/feature-fix",
      variables: { target: "dev & qa=+ü" },
    }),
  ).toEqual({
    outcome: "queued",
    key: "PROJ-PLAN-42",
    build_number: 42,
    link: "https://bamboo.example.com/bamboo/browse/PROJ-PLAN-42",
  });
  expect(calls).toBe(1);
});

test("empty overrides still POST form data; customRevision omitted unless supplied", async () => {
  const api = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async (url, init) => {
      expect(url.search).toBe("");
      expect(init.method).toBe("POST");
      expect(init.body).toBe("");
      return response(queued);
    },
  });
  await api.startBuild({ plan_key: "PROJ-PLAN" });
});

test("authentication, permission and validation errors are distinct; no response secrets echoed", async () => {
  for (const [status, message] of [
    [400, "Invalid request"],
    [401, "Authentication failed"],
    [403, "Forbidden"],
    [404, "not found"],
    [415, "form content type"],
    [429, "Rate limited"],
  ] as const) {
    const api = new Bamboo(config, env.BAMBOO_TOKEN, {
      fetch: async () =>
        response(
          { error: `Authorization: Bearer ${env.BAMBOO_TOKEN}` },
          status,
        ),
    });
    const failure = await api.startBuild({ plan_key: "PROJ-PLAN" }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(failure).toContain(message);
    expect(failure).not.toContain(env.BAMBOO_TOKEN);
  }
});

test("ambiguous POST failures are UNKNOWN and never retried", async () => {
  for (const fetcher of [
    async () => {
      throw new Error(`Authorization: Bearer ${env.BAMBOO_TOKEN}`);
    },
    ...[408, 500, 502, 503].map((status) => async () => response({}, status)),
    ...[302, 307, 308].map(
      (status) => async () =>
        new Response(null, {
          status,
          headers: { Location: "https://evil.invalid" },
        }),
    ),
    async () => new Response("not JSON"),
    async () => new Response('{"buildResultKey":'),
    async () => new Response(null),
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(env.BAMBOO_TOKEN));
          },
        }),
      ),
    async () => response(null),
    async () => response([]),
    async () => response({}),
    async () => response({ buildResultKey: "PROJ-OTHER-1" }),
    async () => response({ buildResultKey: "PROJ-PLAN-0" }),
    async () => response({ buildResultKey: "PROJ-PLAN-JOB-1" }),
  ]) {
    let calls = 0;
    const api = new Bamboo(config, env.BAMBOO_TOKEN, {
      fetch: async () => {
        calls++;
        return fetcher();
      },
    });
    await expect(api.startBuild({ plan_key: "PROJ-PLAN" })).rejects.toThrow(
      "Submission outcome UNKNOWN",
    );
    expect(calls).toBe(1);
  }
});

test("real native fetch never follows redirects to a second server", async () => {
  let leaked = 0,
    calls = 0;
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      leaked++;
      return response(queued);
    },
  });
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: destination.url.href },
      });
    },
  });
  try {
    const api = new Bamboo(
      new Config({ ...env, BAMBOO_URL: source.url.href }),
      env.BAMBOO_TOKEN,
    );
    await expect(api.startBuild({ plan_key: "PROJ-PLAN" })).rejects.toThrow(
      "UNKNOWN",
    );
    await expect(api.listPlans({})).rejects.toThrow(
      "redirects are not followed",
    );
    expect(calls).toBe(2);
    expect(leaked).toBe(0);
  } finally {
    source.stop(true);
    destination.stop(true);
  }
});

test("timeout and cancellation propagate without falsely declaring submission failure", async () => {
  let calls = 0;
  const stalled = async (_url: URL, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls++;
      init.signal!.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  const api = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: stalled,
    timeoutMs: 10,
  });
  await expect(api.startBuild({ plan_key: "PROJ-PLAN" })).rejects.toThrow(
    "UNKNOWN",
  );
  await expect(api.getBuild({ plan_key: "PROJ-PLAN" })).rejects.toThrow(
    "timed out",
  );
  const controller = new AbortController();
  const pending = api.startBuild({ plan_key: "PROJ-PLAN" }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("UNKNOWN");
  await expect(
    api.startBuild({ plan_key: "PROJ-PLAN" }, controller.signal),
  ).rejects.toThrow("before submission");
  expect(calls).toBe(3);
});

test("request failure phases keep safe messages even when body cleanup fails", async () => {
  const failures = [
    {
      fetch: async () => {
        throw new Error(env.BAMBOO_TOKEN);
      },
      message: "Bamboo request failed, timed out or was cancelled.",
    },
    {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(env.BAMBOO_TOKEN));
            },
          }),
        ),
      message:
        "Bamboo returned invalid/oversized JSON or the response timed out (2 MiB limit). Use Bamboo UI for larger logs.",
    },
    {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error(env.BAMBOO_TOKEN);
            },
          }),
          { status: 401 },
        ),
      message: "Bamboo HTTP 401: Authentication failed; check BAMBOO_TOKEN.",
    },
  ];
  for (const { fetch, message } of failures) {
    let calls = 0;
    const api = new Bamboo(config, env.BAMBOO_TOKEN, {
      fetch: async () => {
        calls++;
        return fetch();
      },
    });
    const failure = await api.getBuild({ plan_key: "PROJ-PLAN" }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(failure).toBe(message);
    expect(failure).not.toContain(env.BAMBOO_TOKEN);
    expect(calls).toBe(1);
  }
});

test("list plans is bounded and normalized, latest/explicit result paths include context", async () => {
  const paths: string[] = [];
  const api = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async (url) => {
      paths.push(url.pathname);
      if (url.pathname.endsWith("/plan")) {
        expect(url.searchParams.get("start-index")).toBe("10");
        expect(url.searchParams.get("max-results")).toBe("1");
        return response({
          plans: {
            size: 12,
            plan: [
              {
                key: "PROJ-PLAN",
                name: "name " + env.BAMBOO_TOKEN,
                enabled: true,
                variables: { secret: "omit" },
              },
              { key: "PROJ-OTHER" },
            ],
          },
        });
      }
      return response({
        key: "PROJ-PLAN-42",
        state: "Successful",
        lifeCycleState: "Finished",
        vcsRevisionKey: "abc123",
        stages: {
          stage: [
            {
              results: {
                result: [{ key: "PROJ-PLAN-JOB-42", state: "Successful" }],
              },
            },
          ],
        },
        secret: "omit",
      });
    },
  });
  const plans = await api.listPlans({ start: 10, limit: 1 });
  expect(plans.next_start).toBe(11);
  expect(plans.plans).toEqual([
    {
      key: "PROJ-PLAN",
      name: "name [REDACTED]",
      enabled: true,
      can_start: true,
      link: "https://bamboo.example.com/bamboo/browse/PROJ-PLAN",
    },
  ]);
  const build = await api.getBuild({ plan_key: "PROJ-PLAN" });
  expect(build.key).toBe("PROJ-PLAN-42");
  expect(build.jobs).toMatchObject([{ key: "PROJ-PLAN-JOB-42" }]);
  expect(JSON.stringify(build)).not.toContain("omit");
  await api.getBuild({ result_key: "PROJ-PLAN-42" });
  expect(paths).toEqual([
    "/bamboo/rest/api/latest/plan",
    "/bamboo/rest/api/latest/result/PROJ-PLAN-latest",
    "/bamboo/rest/api/latest/result/PROJ-PLAN-42",
  ]);
  const malformed = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async () => response({}),
  });
  await expect(malformed.getBuild({ plan_key: "PROJ-PLAN" })).rejects.toThrow(
    "valid result key",
  );
});

test("wait_for_build defaults to five minutes and accepts no longer wait", () => {
  const args = { build_key: "PROJ-PLAN-42" };
  expect(inputs.waitForBuild.parse(args).timeout_seconds).toBe(300);
  expect(
    inputs.waitForBuild.safeParse({ ...args, timeout_seconds: 300 }).success,
  ).toBe(true);
  expect(
    inputs.waitForBuild.safeParse({ ...args, timeout_seconds: 301 }).success,
  ).toBe(false);
});

test("wait_for_build returns once for completion, failure, timeout and cancellation", async () => {
  const build = (lifeCycleState: string, state: string) => ({
    key: "PROJ-PLAN-42",
    lifeCycleState,
    state,
  });
  const immediate = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async () => response(build("Finished", "Successful")),
  });
  expect(
    await immediate.waitForBuild({ build_key: "PROJ-PLAN-42" }),
  ).toMatchObject({ outcome: "succeeded", build: { key: "PROJ-PLAN-42" } });

  let polls = 0;
  const transitions = new Bamboo(config, env.BAMBOO_TOKEN, {
    pollIntervalMs: 1,
    fetch: async () =>
      response(
        ++polls === 1
          ? build("InProgress", "Unknown")
          : build("Finished", "Failed"),
      ),
  });
  expect(
    await transitions.waitForBuild({
      build_key: "PROJ-PLAN-42",
      timeout_seconds: 5,
    }),
  ).toMatchObject({ outcome: "failed", build: { state: "Failed" } });
  expect(polls).toBe(2);

  const running = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async () => response(build("InProgress", "Unknown")),
  });
  expect(
    await running.waitForBuild({
      build_key: "PROJ-PLAN-42",
      timeout_seconds: 1,
    }),
  ).toMatchObject({ outcome: "timed_out", build: { lifecycle: "InProgress" } });
  await expect(
    running.waitForBuild({ build_key: "PROJ-PLAN-42", timeout_seconds: 0 }),
  ).rejects.toThrow("Invalid arguments");
  await expect(
    running.waitForBuild({ build_key: "PROJ-PLAN-latest" }),
  ).rejects.toThrow("Invalid arguments");

  const controller = new AbortController();
  const waiting = running.waitForBuild(
    { build_key: "PROJ-PLAN-42", timeout_seconds: 30 },
    controller.signal,
  );
  controller.abort();
  await expect(waiting).rejects.toThrow();
});

test("logs have bounded text/entries, token redaction and explicitly partial scope", async () => {
  const api = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async (url) => {
      expect(url.pathname).toBe(
        "/bamboo/rest/api/latest/result/PROJ-PLAN-JOB-42",
      );
      expect(url.searchParams.get("expand")).toBe("logEntries");
      return response({
        logEntries: {
          size: 4,
          logEntry: [
            { unstyledLog: env.BAMBOO_TOKEN },
            { unstyledLog: "x".repeat(100) },
            { unstyledLog: "omit" },
          ],
        },
      });
    },
  });
  const log = await api.getJobLog({
    job_result_key: "PROJ-PLAN-JOB-42",
    max_lines: 2,
    max_chars: 20,
  });
  expect(log.text).toBe("[REDACTED]\nxxxxxxxxx");
  expect(log.returned_entries).toBe(2);
  expect(log.truncated).toBe(true);
  expect(log.scope).toContain("may be partial");
  const unsupported = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async () => response({}),
  });
  await expect(
    unsupported.getJobLog({ job_result_key: "PROJ-PLAN-JOB-42" }),
  ).rejects.toThrow("Bamboo UI");
  const multiline = new Bamboo(config, env.BAMBOO_TOKEN, {
    fetch: async () =>
      response({ logEntries: { logEntry: [{ unstyledLog: "a\nb\nc\nd" }] } }),
  });
  const bounded = await multiline.getJobLog({
    job_result_key: "PROJ-PLAN-JOB-42",
    max_lines: 2,
  });
  expect(bounded.text).toBe("a\nb");
  expect(bounded.truncated).toBe(true);
});

test("streaming download is capped and cancelled; oversized POST response is ambiguous", async () => {
  let cancelled = 0;
  const api = new Bamboo(config, env.BAMBOO_TOKEN, {
    maxResponseBytes: 32,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(64)));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
  });
  await expect(
    api.getJobLog({ job_result_key: "PROJ-PLAN-JOB-42" }),
  ).rejects.toThrow("2 MiB limit");
  await expect(api.startBuild({ plan_key: "PROJ-PLAN" })).rejects.toThrow(
    "UNKNOWN",
  );
  expect(cancelled).toBe(2);
});
