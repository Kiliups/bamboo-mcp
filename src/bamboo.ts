import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { type Config, planKey, variableName } from "./config";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  type Json,
  readJsonObject,
  validate,
} from "./utils";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_JOBS = 100;

const UNKNOWN_SUBMISSION =
  "Submission outcome UNKNOWN: Bamboo may have queued the build. Check Bamboo before retrying; no automatic retry was made.";

const STATUS_MESSAGES: Record<number, string> = {
  400: "Invalid request or Bamboo concurrency limit reached.",
  401: "Authentication failed; check BAMBOO_TOKEN.",
  403: "Forbidden; token/user lacks read or trigger permission.",
  404: "Plan/result not found or not visible to this token.",
  415: "Bamboo rejected the form content type.",
  429: "Rate limited by Bamboo or its proxy.",
};

const resultKey = z
  .string()
  .max(160)
  .regex(/^[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)?-[1-9][0-9]*$/);
const jobResultKey = z
  .string()
  .max(160)
  .regex(/^[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
const revision = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
  .refine((s) => !s.includes("..") && !s.includes("//") && !/[/.]$/.test(s));

export const inputs = {
  listPlans: z
    .object({
      start: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  getBuild: z
    .object({
      plan_key: planKey.optional(),
      result_key: resultKey.optional(),
    })
    .strict()
    .refine(
      (v) => Boolean(v.plan_key) !== Boolean(v.result_key),
      "Supply exactly one key",
    ),
  waitForBuild: z
    .object({
      build_key: resultKey,
      timeout_seconds: z.number().int().min(1).max(300).default(300),
    })
    .strict(),
  getJobLog: z
    .object({
      job_result_key: jobResultKey,
      max_lines: z.number().int().min(1).max(200).default(100),
      max_chars: z.number().int().min(1).max(16_000).default(12_000),
    })
    .strict(),
  startBuild: z
    .object({
      plan_key: planKey,
      revision: revision.optional(),
      variables: z
        .record(variableName, z.string().max(4096))
        .default({})
        .refine((v) => Object.keys(v).length <= 32, "At most 32 overrides"),
    })
    .strict(),
};

function httpErrorMessage(status: number, isSubmission: boolean): string {
  const isRedirect = status >= 300 && status < 400;
  if (isSubmission && (status >= 500 || status === 408 || isRedirect))
    return UNKNOWN_SUBMISSION;
  if (isRedirect) return "Request rejected; redirects are not followed.";
  return STATUS_MESSAGES[status] ?? "Request rejected.";
}

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

type BambooOptions = {
  fetch?: Fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  pollIntervalMs?: number;
};

type RequestOptions = {
  query?: Record<string, string>;
  form?: URLSearchParams;
  signal?: AbortSignal;
};

export class Bamboo {
  private readonly config: Config;
  private readonly token: string;
  private readonly fetcher: Fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly pollIntervalMs: number;

  constructor(config: Config, token: string, options: BambooOptions = {}) {
    if (!token) throw new Error("A Bamboo token is required.");
    this.config = config;
    this.token = token;
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  redact(text: string): string {
    return text.replaceAll(this.token, "[REDACTED]");
  }

  stringify(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "string" ? this.redact(v) : v,
    );
  }

  async listPlans(args: unknown, signal?: AbortSignal) {
    const { start, limit } = validate(inputs.listPlans, args);
    const data = await this.request("plan", {
      query: {
        expand: "plans.plan",
        "start-index": String(start),
        "max-results": String(limit),
      },
      signal,
    });
    const page = asObject(data.plans);
    if (!Array.isArray(page.plan))
      throw new Error("Bamboo response did not include plans.plan.");

    const plans = page.plan.slice(0, limit).map((value) => {
      const plan = asObject(value);
      const key = plan.key ?? plan.planKey;
      if (!planKey.safeParse(key).success)
        throw new Error("Bamboo returned an invalid plan key.");
      return {
        key: String(key),
        name: this.cleanString(plan.name ?? plan.planName),
        enabled: asBoolean(plan.enabled),
        can_start: this.config.canStart(String(key)),
        link: this.browseLink(String(key)),
      };
    });

    const total = asNumber(page.size);
    const end = start + plans.length;
    const hasMore = total !== undefined && plans.length > 0 && end < total;
    return { plans, start, total, next_start: hasMore ? end : null };
  }

  async getBuild(args: unknown, signal?: AbortSignal) {
    const { plan_key, result_key } = validate(inputs.getBuild, args);
    const key = result_key ?? `${plan_key}-latest`;
    const data = await this.request(`result/${key}`, {
      query: { expand: "stages.stage.results.result" },
      signal,
    });
    const jobs = asArray(asObject(data.stages).stage).flatMap((stage) =>
      asArray(asObject(asObject(stage).results).result),
    );
    return {
      ...this.summarizeResult(data),
      jobs: jobs
        .slice(0, MAX_JOBS)
        .map((job) => this.summarizeResult(asObject(job))),
      jobs_truncated: jobs.length > MAX_JOBS,
    };
  }

  async waitForBuild(args: unknown, signal?: AbortSignal) {
    const { build_key, timeout_seconds } = validate(inputs.waitForBuild, args);
    const deadline = AbortSignal.timeout(timeout_seconds * 1000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    let latest: Awaited<ReturnType<Bamboo["getBuild"]>> | undefined;
    try {
      while (true) {
        latest = await this.getBuild({ result_key: build_key }, combinedSignal);
        if (latest.lifecycle?.toLowerCase() === "finished") {
          const succeeded = latest.state?.toLowerCase() === "successful";
          return { outcome: succeeded ? "succeeded" : "failed", build: latest };
        }
        await sleep(this.pollIntervalMs, undefined, { signal: combinedSignal });
      }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted)
        return { outcome: "timed_out", build: latest };
      throw error;
    }
  }

  async getJobLog(args: unknown, signal?: AbortSignal) {
    const { job_result_key, max_lines, max_chars } = validate(
      inputs.getJobLog,
      args,
    );
    const data = await this.request(`result/${job_result_key}`, {
      query: { expand: "logEntries" },
      signal,
    });
    const logs = asObject(data.logEntries);
    if (!Array.isArray(logs.logEntry)) {
      throw new Error(
        "Bamboo did not return job logEntries; use the Bamboo UI to view/download this log.",
      );
    }

    const entries = logs.logEntry.slice(0, max_lines);
    const lines = entries
      .map(
        (entry) =>
          this.cleanString(
            asObject(entry).unstyledLog ?? asObject(entry).log,
            max_chars + 1,
          ) ?? "",
      )
      .join("\n")
      .split("\n");
    const bounded = lines.slice(0, max_lines).join("\n");
    const serverHasMore =
      typeof logs.size === "number" && logs.size > logs.logEntry.length;

    return {
      key: job_result_key,
      text: bounded.slice(0, max_chars),
      returned_entries: entries.length,
      truncated:
        logs.logEntry.length > max_lines ||
        lines.length > max_lines ||
        bounded.length > max_chars ||
        serverHasMore,
      scope: "REST logEntries only; may be partial",
      link: this.browseLink(job_result_key),
    };
  }

  async startBuild(args: unknown, signal?: AbortSignal) {
    const { plan_key, revision, variables } = validate(inputs.startBuild, args);
    if (!this.config.canStart(plan_key)) {
      throw new Error(
        "Plan is not in BAMBOO_ALLOWED_PLANS; no build submitted.",
      );
    }
    if (
      Object.keys(variables).some((name) => !this.config.allowsVariable(name))
    ) {
      throw new Error(
        "Variable is not in BAMBOO_ALLOWED_VARIABLES; no build submitted.",
      );
    }

    const form = new URLSearchParams(
      Object.entries(variables).map(([name, value]) => [
        `bamboo.variable.${name}`,
        value,
      ]),
    );
    const data = await this.request(`queue/${plan_key}`, {
      query: revision ? { customRevision: revision } : {},
      form,
      signal,
    });

    const key = data.buildResultKey;
    const isPlanResult =
      resultKey.safeParse(key).success &&
      String(key).startsWith(`${plan_key}-`) &&
      String(key).split("-").length === 3;
    if (!isPlanResult) throw new Error(UNKNOWN_SUBMISSION);

    return {
      outcome: "queued",
      key: String(key),
      build_number: asNumber(data.buildNumber),
      link: this.browseLink(String(key)),
    };
  }

  private cleanString(value: unknown, maxLength = 512) {
    return typeof value === "string"
      ? this.redact(value).slice(0, maxLength)
      : undefined;
  }

  private browseLink(key: string): string {
    return `${this.config.url}/browse/${key}`;
  }

  private summarizeResult(data: Json) {
    const key = data.key ?? asObject(data.planResultKey).key;
    if (!resultKey.safeParse(key).success)
      throw new Error("Bamboo response did not include a valid result key.");
    return {
      key: String(key),
      state: this.cleanString(data.state ?? data.buildState),
      lifecycle: this.cleanString(data.lifeCycleState),
      revision: this.cleanString(data.vcsRevisionKey),
      started: this.cleanString(data.buildStartedTime),
      completed: this.cleanString(data.buildCompletedTime),
      duration_seconds: asNumber(data.buildDurationInSeconds),
      link: this.browseLink(String(key)),
    };
  }

  private async request(
    path: string,
    { query, form, signal }: RequestOptions = {},
  ): Promise<Json> {
    const isSubmission = form !== undefined;
    const url = new URL(`${this.config.url}/rest/api/latest/${path}`);
    url.search = new URLSearchParams(query).toString();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([timeout, signal])
      : timeout;
    if (combinedSignal.aborted)
      throw new Error("Request cancelled before submission.");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (isSubmission)
      headers["Content-Type"] = "application/x-www-form-urlencoded";

    let failureMessage = isSubmission
      ? UNKNOWN_SUBMISSION
      : "Bamboo request failed, timed out or was cancelled.";
    try {
      const response = await this.fetcher(url, {
        method: isSubmission ? "POST" : "GET",
        headers,
        body: form?.toString(),
        redirect: "manual",
        signal: combinedSignal,
      });
      if (!response.ok) {
        failureMessage = `Bamboo HTTP ${response.status}: ${httpErrorMessage(response.status, isSubmission)}`;
        await response.body?.cancel().catch(() => {});
        throw new Error(failureMessage);
      }
      failureMessage = isSubmission
        ? UNKNOWN_SUBMISSION
        : "Bamboo returned invalid/oversized JSON or the response timed out (2 MiB limit). Use Bamboo UI for larger logs.";
      return await readJsonObject(response, this.maxResponseBytes);
    } catch {
      throw new Error(failureMessage);
    }
  }
}
