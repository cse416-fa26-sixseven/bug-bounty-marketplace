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

/**
 * Without AUTH_ORIGIN the SIWE domain comes from the request, which any client
 * can forge. With a chain (sign-in on) that is refused under
 * NODE_ENV=production (throws) and only warned about otherwise (returns the
 * warning). Returns null when there is nothing to say.
 */
export function checkAuthOrigin(
  config: AuthConfig,
  env: NodeJS.ProcessEnv,
  chainConfigured: boolean,
): string | null {
  if (!chainConfigured || config.origin) return null;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_ORIGIN is required with a chain in production: set it to the web app's public origin (e.g. https://bountyguard.example)",
    );
  }
  return "AUTH_ORIGIN is unset: sign-in messages name the domain each request comes from (local dev only)";
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
