import { resolveApiPath } from "../config/backend";

export type LogLevel = "debug" | "info" | "warn" | "error";

declare global {
  interface Window {
    __ROUTA_DEBUG__?: boolean;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__ROUTA_DEBUG__ === true) return true;
  try {
    return localStorage.getItem("routa.debug") === "1";
  } catch {
    return false;
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function shouldSuppressTeardownError(err: unknown): boolean {
  const message = toErrorMessage(err);
  if (!message.includes("Failed to fetch")) return false;
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden";
}

export function logRuntime(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  const line = `[${nowIso()}][${scope}] ${message}`;
  const shouldPrintDebug = level !== "debug" || isDebugEnabled();

  if (shouldPrintDebug) {
    if (level === "error") console.error(line, meta ?? "");
    else if (level === "warn") console.warn(line, meta ?? "");
    else console.log(line, meta ?? "");
  }
}

/**
 * Fetch helper for API routes.
 *
 * Historically this wrapper also routed requests to an embedded desktop
 * backend; the app is Web-only now, so it is a thin same-origin `fetch`
 * kept as a stable call-site while the request layer converges.
 *
 * Usage: `desktopAwareFetch("/api/notes?workspaceId=abc")`
 */
export function desktopAwareFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(resolveApiPath(path), options);
}
