import type { z } from "zod";

/** Thrown when a request fails at the network/HTTP layer (non-2xx, or an
 * unparseable response). Distinct from a Zod parse error, which indicates
 * the mock (or real) API returned a shape that doesn't match the contract. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// In the browser, relative paths resolve against the page origin. Under
// Node (Vitest), `fetch` has no implicit origin, so give relative paths a
// base - MSW's node server intercepts the request before it ever reaches
// the network either way.
const BASE_URL = typeof window === "undefined" ? "http://localhost" : "";

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body || res.statusText;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // body wasn't JSON - fall back to raw text/status text above.
    }
    throw new ApiError(message, res.status, path);
  }
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

/** GETs `path` and validates the JSON response against `schema`, throwing
 * if the shape doesn't match - bad mock (or real API) data fails loudly
 * instead of silently flowing into components. */
export async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await request(path));
}

export async function postJson<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const data = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return schema.parse(data);
}

export async function putJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const data = await request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return schema.parse(data);
}

/** POSTs a `FormData` body (for `.sol` / `.t.sol` file uploads) and
 * validates the JSON response against `schema`. */
export async function postForm<T>(path: string, form: FormData, schema: z.ZodType<T>): Promise<T> {
  const data = await request(path, { method: "POST", body: form });
  return schema.parse(data);
}

/** Builds a query string from a plain object, dropping undefined/empty
 * values. */
export function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
