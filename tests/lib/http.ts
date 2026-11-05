import type { z } from "zod";

export interface JsonResponse<T> {
  status: number;
  /** Parsed with the schema on 2xx; the raw error body otherwise. */
  body: T;
}

async function decode<S extends z.ZodType>(
  res: Response,
  schema?: S,
): Promise<JsonResponse<z.infer<S>>> {
  const json: unknown = await res.json();
  // Only successful responses are validated: error bodies ({ error }) are not
  // part of the shared schemas and tests assert on them directly.
  const body = schema && res.ok ? schema.parse(json) : (json as z.infer<S>);
  return { status: res.status, body };
}

/** fetch + JSON decode. When a schema is given a 2xx body is parsed with it,
 * so a response that drifts from @bbm/shared fails the test. */
export async function getJson<S extends z.ZodType>(url: string, schema?: S) {
  return decode(await fetch(url), schema);
}

export async function postForm<S extends z.ZodType>(url: string, form: FormData, schema?: S) {
  return decode(await fetch(url, { method: "POST", body: form }), schema);
}

export async function postJson<S extends z.ZodType>(url: string, body: unknown, schema?: S) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return decode(res, schema);
}
