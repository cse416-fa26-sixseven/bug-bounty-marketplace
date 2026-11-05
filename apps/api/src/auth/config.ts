import { parseBoolEnv } from "../env.js";

export interface AuthConfig {
  /** The web app's public origin (AUTH_ORIGIN, e.g. https://bountyguard.example).
   * Every sign-in message names its host as the SIWE domain and the origin as
   * the URI. Null: both come from each request (Origin header, else Host),
   * which is only safe for local development. */
  origin: string | null;
  /** Mark the session cookie Secure (COOKIE_SECURE). Defaults to true when
   * AUTH_ORIGIN is https. */
  secureCookie: boolean;
}

/** Reads AUTH_ORIGIN and COOKIE_SECURE. Throws on an AUTH_ORIGIN that is not
 * a bare http(s) origin. */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const raw = env.AUTH_ORIGIN?.trim();
  let origin: string | null = null;
  if (raw) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`AUTH_ORIGIN must be an http(s) origin such as https://bountyguard.example, got ${raw}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`AUTH_ORIGIN must be an http(s) origin with no path, got ${raw}`);
    }
    origin = url.origin;
  }
  return {
    origin,
    secureCookie: parseBoolEnv(env.COOKIE_SECURE, origin?.startsWith("https:") ?? false),
  };
}
