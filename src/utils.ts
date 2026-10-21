import type { z } from "zod";

export type Json = Record<string, unknown>;

export const INVALID_ARGUMENTS =
  "Invalid arguments; unknown fields, malformed keys/revisions and out-of-range values are rejected.";

export const asObject = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const asNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;
export const asBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

export function validate<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error(INVALID_ARGUMENTS);
  return parsed.data;
}

export async function readJsonObject(
  response: Response,
  maxBytes: number,
): Promise<Json> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body.");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Response too large.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data: unknown = JSON.parse(text + decoder.decode());
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new Error("Expected a JSON object.");
  return data as Json;
}

export function commaList(value: string | undefined): string[] {
  return value?.trim() ? value.split(",").map((s) => s.trim()) : [];
}

export function exactList(
  value: string | undefined,
  name: string,
  schema: z.ZodType<string>,
): Set<string> {
  const entries = commaList(value);
  if (entries.some((entry) => !schema.safeParse(entry).success)) {
    throw new Error(`${name} contains an invalid entry.`);
  }
  return new Set(entries);
}
