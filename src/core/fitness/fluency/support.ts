/**
 * Utility functions for the harness fluency engine.
 * Ported from Rust support.rs.
 */

import { MAX_REGEX_PATTERN_LENGTH, type LevelChange } from "./types.js";

/**
 * Build a RegExp from a pattern and flags string, matching the Rust engine's
 * build_regex in support.rs. Rejects patterns longer than
 * MAX_REGEX_PATTERN_LENGTH and unsupported flag characters.
 *
 * Supported flags: i, m, s, U, u, x
 * (The Rust 'R' / crlf flag is not supported in JS RegExp and is silently
 * ignored since the Web engine never runs on Windows-style line endings.)
 */
export function buildRegex(pattern: string, flags: string, label: string): RegExp {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      label + ".pattern exceeds max length " + MAX_REGEX_PATTERN_LENGTH,
    );
  }

  let jsFlags = "";
  for (const flag of flags) {
    switch (flag) {
      case "i":
        jsFlags += "i";
        break;
      case "m":
        jsFlags += "m";
        break;
      case "s":
        jsFlags += "s";
        break;
      case "u":
        // JS 'u' flag — unicode mode. Only add if not already present.
        if (!jsFlags.includes("u")) jsFlags += "u";
        break;
      case "U":
        // swap_greed — no direct JS equivalent; approximate with lazy via
        // pattern rewriting is not feasible, so we ignore this flag.
        break;
      case "x":
        // ignore_whitespace — no direct JS equivalent; ignore.
        break;
      case "R":
        // crlf — not applicable in JS; ignore.
        break;
      default:
        throw new Error(
          label + " has invalid regex settings: unsupported flag '" + flag + "'",
        );
    }
  }

  try {
    return new RegExp(pattern, jsFlags);
  } catch (error) {
    throw new Error(
      label + " has invalid regex settings: " + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

/**
 * Format a fractional value as a percentage string.
 * `null` → `"n/a"`.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value == null) return "n/a";
  return Math.round(value * 100) + "%";
}

/**
 * Map a LevelChange enum to its display label.
 */
export function levelChangeLabel(change: LevelChange): string {
  switch (change) {
    case "same":
      return "same";
    case "up":
      return "up";
    case "down":
      return "down";
  }
}
