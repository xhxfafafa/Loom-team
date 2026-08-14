/**
 * Platform Abstraction Layer — Entry Point
 *
 * Provides a unified API for platform-specific capabilities.
 * Uses a registration pattern so that alternative bridges can be
 * injected without the web build needing to know about them.
 *
 * The app is Web-only; the default bridge is `WebPlatformBridge`.
 *
 * Usage:
 *   import { getPlatformBridge } from "@/core/platform";
 *   const bridge = getPlatformBridge();
 *
 *   // Check capabilities
 *   if (bridge.process.isAvailable()) {
 *     const handle = bridge.process.spawn("git", ["status"]);
 *   }
 *
 *   // Use platform-appropriate dialogs
 *   const file = await bridge.dialog.open({ filters: [{ name: "JSON", extensions: ["json"] }] });
 *
 *   // Platform detection
 *   if (bridge.env.isServerless()) { ... }
 */

export type { 
  IPlatformBridge,
  IPlatformProcess,
  IPlatformFs,
  IPlatformDb,
  IPlatformGit,
  IPlatformTerminal,
  IPlatformDialog,
  IPlatformShell,
  IPlatformEnv,
  IPlatformEvents,
  IProcessHandle,
  ITerminalHandle,
  SpawnOptions,
  ExecOptions,
  DirEntry,
  DatabaseType,
  PlatformType,
  OpenDialogOptions,
  SaveDialogOptions,
  MessageDialogOptions,
  TerminalCreateOptions,
  GitBranchInfo,
  GitStatus,
  EventHandler,
  UnlistenFn,
} from "./interfaces";

export { WebPlatformBridge } from "./web-bridge";

import type { IPlatformBridge } from "./interfaces";
import { WebPlatformBridge } from "./web-bridge";

// ─── Bridge Registry ──────────────────────────────────────────────────────

const GLOBAL_KEY = "__routa_platform_bridge__";

/**
 * Register a custom platform bridge.
 *
 * Call this at app startup before any other code accesses the bridge.
 * The app is Web-only, so the default bridge is `WebPlatformBridge`;
 * this hook exists for future or alternative bridge implementations.
 */
export function registerPlatformBridge(bridge: IPlatformBridge): void {
  const g = globalThis as Record<string, unknown>;
  g[GLOBAL_KEY] = bridge;
  console.log(`[Platform] Registered ${bridge.platform} bridge`);
}

/**
 * Get the platform bridge singleton.
 *
 * If a custom bridge was registered (via registerPlatformBridge), returns that.
 * Otherwise, creates and caches a WebPlatformBridge (Node.js / Vercel).
 */
export function getPlatformBridge(): IPlatformBridge {
  const g = globalThis as Record<string, unknown>;
  
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new WebPlatformBridge();
    console.log("[Platform] Initialized web bridge (default)");
  }
  
  return g[GLOBAL_KEY] as IPlatformBridge;
}

/**
 * Get the platform bridge for server-side code (always WebPlatformBridge).
 * Use this in Next.js API routes and server components.
 */
export function getServerBridge(): IPlatformBridge {
  const g = globalThis as Record<string, unknown>;
  const SERVER_KEY = "__routa_server_bridge__";
  
  if (!g[SERVER_KEY]) {
    g[SERVER_KEY] = new WebPlatformBridge();
  }
  
  return g[SERVER_KEY] as IPlatformBridge;
}

// ─── Platform Detection Helpers ───────────────────────────────────────────

/** Check if running in a serverless environment */
export function isServerless(): boolean {
  return !!(
    typeof process !== "undefined" && (
      process.env?.VERCEL ||
      process.env?.AWS_LAMBDA_FUNCTION_NAME ||
      process.env?.NETLIFY ||
      process.env?.FUNCTION_NAME
    )
  );
}
