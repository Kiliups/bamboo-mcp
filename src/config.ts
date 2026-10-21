import { z } from "zod";
import { exactList } from "./utils";

export const planKey = z
  .string()
  .max(128)
  .regex(/^[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*$/);
export const variableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

type Env = Record<string, string | undefined>;

function bambooUrl(value: string | undefined): string {
  if (!value)
    throw new Error("BAMBOO_URL is required; set it to your Bamboo base URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BAMBOO_URL must be an absolute HTTPS Bamboo base URL.");
  }
  const isLoopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
  const hasExtras =
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#");
  if ((url.protocol !== "https:" && !isLoopbackHttp) || hasExtras) {
    throw new Error(
      "BAMBOO_URL requires HTTPS (HTTP only on loopback), without credentials, query or fragment.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

export class Config {
  readonly url: string;
  readonly allowAllPlans: boolean;
  readonly allowedPlans: Set<string>;
  readonly allowedVariables: Set<string>;

  constructor(env: Env = process.env) {
    const plans = env.BAMBOO_ALLOWED_PLANS ?? "*";
    this.url = bambooUrl(env.BAMBOO_URL);
    this.allowAllPlans = plans.trim() === "*";
    this.allowedPlans = this.allowAllPlans
      ? new Set()
      : exactList(
          plans,
          "BAMBOO_ALLOWED_PLANS",
          planKey.or(z.string().max(128).regex(/^[A-Z][A-Z0-9]*-\*$/)),
        );
    this.allowedVariables = exactList(
      env.BAMBOO_ALLOWED_VARIABLES,
      "BAMBOO_ALLOWED_VARIABLES",
      variableName,
    );
  }

  canStart(key: string): boolean {
    return (
      this.allowAllPlans ||
      this.allowedPlans.has(key) ||
      (planKey.safeParse(key).success &&
        this.allowedPlans.has(`${key.split("-")[0]}-*`))
    );
  }

  allowsVariable(name: string): boolean {
    return this.allowedVariables.has(name);
  }
}
