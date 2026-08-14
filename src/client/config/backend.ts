const API_PREFIX = "/api";

function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * Resolve an API path to a same-origin `/api` route.
 *
 * Absolute http(s) URLs pass through unchanged; relative paths are
 * normalized onto the `/api` prefix. An explicit base URL is supported for
 * reusable clients (ACP/skills/RPC) constructed against a specific backend;
 * in the browser no base is configured, so requests stay same-origin.
 */
export function resolveApiPath(path: string, explicitBaseUrl?: string): string {
  const value = path.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  const normalizedPath = value.startsWith("/") ? value : `/${value}`;
  const apiPath = normalizedPath.startsWith(`${API_PREFIX}/`) || normalizedPath === API_PREFIX
    ? normalizedPath
    : `${API_PREFIX}${normalizedPath}`;
  const baseUrl = normalizeBaseUrl(explicitBaseUrl);
  if (!baseUrl) return apiPath;
  return `${baseUrl}${apiPath}`;
}
