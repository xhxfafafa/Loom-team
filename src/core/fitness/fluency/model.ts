/**
 * YAML model loading, validation, and detector parsing.
 * Ported from Rust model.rs.
 *
 * Supports the `extends` inheritance mechanism where a profile overlay
 * YAML can extend a base model YAML. Criteria arrays are concatenated
 * (not replaced) when extending.
 */

import * as fs from "fs";
import * as path from "path";

import yaml from "js-yaml";

import { buildRegex } from "./support.js";
import type {
  DetectorDefinition,
  EvidenceMode,
  FluencyAiCheck,
  FluencyCapabilityGroup,
  FluencyCriterion,
  FluencyDimension,
  FluencyLevel,
  FluencyModel,
  PathSegment,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate a fluency model from a YAML file path.
 * Supports the `extends` mechanism for profile overlays.
 */
export function loadFluencyModel(modelPath: string): FluencyModel {
  const visited = new Set<string>();
  const raw = loadRawFluencyModel(modelPath, visited);
  return parseModel(raw);
}

// ---------------------------------------------------------------------------
// Raw YAML loading with extends support
// ---------------------------------------------------------------------------

function loadRawFluencyModel(
  modelPath: string,
  visited: Set<string>,
): Record<string, unknown> {
  const resolved = path.resolve(modelPath);

  if (visited.has(resolved)) {
    throw new Error("cyclic harness fluency model extends detected at " + resolved);
  }

  visited.add(resolved);
  const content = fs.readFileSync(resolved, "utf-8");
  const parsed = yaml.load(content) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("harness fluency model must be an object");
  }

  const extendsValue = parsed["extends"];
  if (extendsValue == null) {
    visited.delete(resolved);
    return parsed;
  }

  if (typeof extendsValue !== "string" || extendsValue.trim() === "") {
    throw new Error("model.extends must be a non-empty string");
  }

  const baseModelPath = path.join(path.dirname(resolved), extendsValue);
  const baseModel = loadRawFluencyModel(baseModelPath, visited);
  visited.delete(resolved);

  // Merge: child keys override base keys
  const merged: Record<string, unknown> = { ...baseModel };
  for (const [key, value] of Object.entries(parsed)) {
    merged[key] = value;
  }
  delete merged["extends"];

  // Criteria arrays are concatenated, not replaced
  if (parsed["criteria"] != null && baseModel["criteria"] != null) {
    const baseCriteria = expectArray(baseModel["criteria"], "base model.criteria");
    const childCriteria = expectArray(parsed["criteria"], "model.criteria");
    merged["criteria"] = [...baseCriteria, ...childCriteria];
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function parseModel(root: Record<string, unknown>): FluencyModel {
  const levels = parseLevels(root);
  const dimensions = parseDimensions(root);
  const capabilityGroups = parseCapabilityGroups(root);
  const criteria = parseCriteria(root, levels, dimensions, capabilityGroups);

  // Validate cell coverage: each level×dimension must have >= 2 criteria
  for (const level of levels) {
    for (const dimension of dimensions) {
      const count = criteria.filter(
        (c) => c.level === level.id && c.dimension === dimension.id,
      ).length;
      if (count < 2) {
        throw new Error(
          "cell " + dimension.id + " × " + level.id + " must declare at least 2 criteria",
        );
      }
    }
  }

  return {
    version: expectU32(root["version"], "model.version", 1),
    levels,
    dimensions,
    capabilityGroups,
    criteria,
  };
}

function parseLevels(root: Record<string, unknown>): FluencyLevel[] {
  const raw = expectArray(
    getRequired(root, "levels", "model.levels"),
    "model.levels",
  );
  if (raw.length === 0) {
    throw new Error("harness fluency model.levels must be a non-empty array");
  }

  const levels: FluencyLevel[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const record = expectObject(raw[i], "levels[" + i + "]");
    const id = expectString(getRequired(record, "id", "levels[" + i + "].id"), "levels[" + i + "].id");
    const name = expectString(getRequired(record, "name", "levels[" + i + "].name"), "levels[" + i + "].name");
    if (ids.has(id)) {
      throw new Error("harness fluency model.levels contains duplicate ids");
    }
    ids.add(id);
    levels.push({ id, name });
  }

  return levels;
}

function parseDimensions(root: Record<string, unknown>): FluencyDimension[] {
  const raw = expectArray(
    getRequired(root, "dimensions", "model.dimensions"),
    "model.dimensions",
  );
  if (raw.length === 0) {
    throw new Error("harness fluency model.dimensions must be a non-empty array");
  }

  const dimensions: FluencyDimension[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const record = expectObject(raw[i], "dimensions[" + i + "]");
    const id = expectString(getRequired(record, "id", "dimensions[" + i + "].id"), "dimensions[" + i + "].id");
    const name = expectString(getRequired(record, "name", "dimensions[" + i + "].name"), "dimensions[" + i + "].name");
    if (ids.has(id)) {
      throw new Error("harness fluency model.dimensions contains duplicate ids");
    }
    ids.add(id);
    dimensions.push({ id, name });
  }

  return dimensions;
}

function parseCapabilityGroups(root: Record<string, unknown>): FluencyCapabilityGroup[] {
  const rawValue = root["capability_groups"];
  if (rawValue == null) return [];

  const raw = expectArray(rawValue, "model.capability_groups");
  const groups: FluencyCapabilityGroup[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const record = expectObject(raw[i], "capability_groups[" + i + "]");
    const id = expectString(getRequired(record, "id", "capability_groups[" + i + "].id"), "capability_groups[" + i + "].id");
    const name = expectString(getRequired(record, "name", "capability_groups[" + i + "].name"), "capability_groups[" + i + "].name");
    if (ids.has(id)) {
      throw new Error("harness fluency model.capability_groups contains duplicate ids");
    }
    ids.add(id);
    groups.push({ id, name });
  }

  return groups;
}

function parseCriteria(
  root: Record<string, unknown>,
  levels: FluencyLevel[],
  dimensions: FluencyDimension[],
  capabilityGroups: FluencyCapabilityGroup[],
): FluencyCriterion[] {
  const raw = expectArray(
    getRequired(root, "criteria", "model.criteria"),
    "model.criteria",
  );
  if (raw.length === 0) {
    throw new Error("harness fluency model.criteria must be a non-empty array");
  }

  const levelIds = new Set(levels.map((l) => l.id));
  const dimensionIds = new Set(dimensions.map((d) => d.id));
  const capabilityGroupIds = new Set(capabilityGroups.map((g) => g.id));

  const criteria: FluencyCriterion[] = [];
  const ids = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const record = expectObject(raw[i], "criteria[" + i + "]");
    const label = "criteria[" + i + "]";

    const id = expectString(getRequired(record, "id", label + ".id"), label + ".id");
    if (ids.has(id)) {
      throw new Error("harness fluency model.criteria contains duplicate ids");
    }
    ids.add(id);

    const level = expectString(getRequired(record, "level", label + ".level"), label + ".level");
    if (!levelIds.has(level)) {
      throw new Error(label + ".level references unknown level \"" + level + "\"");
    }

    const dimension = expectString(getRequired(record, "dimension", label + ".dimension"), label + ".dimension");
    if (!dimensionIds.has(dimension)) {
      throw new Error(label + ".dimension references unknown dimension \"" + dimension + "\"");
    }

    let capabilityGroup: string;
    if (record["capability_group"] != null) {
      capabilityGroup = expectString(record["capability_group"], label + ".capability_group");
      if (
        capabilityGroupIds.size > 0
        && !capabilityGroupIds.has(capabilityGroup)
        && !dimensionIds.has(capabilityGroup)
      ) {
        throw new Error(
          label + ".capability_group references unknown group \"" + capabilityGroup + "\"",
        );
      }
    } else {
      capabilityGroup = dimension;
    }

    const profiles = record["profiles"] != null
      ? parseStringArray(record["profiles"], label + ".profiles")
      : [];

    const detectorRaw = getRequired(record, "detector", label + ".detector");
    const detector = parseDetector(detectorRaw, label + ".detector");

    const evidenceMode = parseEvidenceMode(
      record["evidence_mode"],
      label + ".evidence_mode",
      record["detector"],
    );

    const aiCheck = record["ai_check"] != null
      ? parseAiCheck(record["ai_check"], label + ".ai_check")
      : null;

    criteria.push({
      id,
      level,
      dimension,
      capabilityGroup,
      weight: expectU32(record["weight"], label + ".weight", 1),
      critical: expectBool(record["critical"], label + ".critical", false),
      profiles,
      evidenceMode,
      whyItMatters: expectString(
        getRequired(record, "why_it_matters", label + ".why_it_matters"),
        label + ".why_it_matters",
      ),
      recommendedAction: expectString(
        getRequired(record, "recommended_action", label + ".recommended_action"),
        label + ".recommended_action",
      ),
      evidenceHint: expectString(
        getRequired(record, "evidence_hint", label + ".evidence_hint"),
        label + ".evidence_hint",
      ),
      aiCheck,
      detector,
    });
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// Detector parsing
// ---------------------------------------------------------------------------

function parseDetector(value: unknown, label: string): DetectorDefinition {
  const detector = expectObject(value, label);
  const detectorType = expectString(
    getRequired(detector, "type", label + ".type"),
    label + ".type",
  );

  switch (detectorType) {
    case "file_exists":
      return {
        type: "file_exists",
        path: expectString(getRequired(detector, "path", label + ".path"), label + ".path"),
      };

    case "file_contains_regex": {
      const { pattern, flags } = parseRegexSettings(detector, label, "i");
      return {
        type: "file_contains_regex",
        path: expectString(getRequired(detector, "path", label + ".path"), label + ".path"),
        pattern,
        flags,
      };
    }

    case "all_of": {
      const nested = expectArray(
        getRequired(detector, "detectors", label + ".detectors"),
        label + ".detectors",
      );
      if (nested.length === 0) {
        throw new Error(label + ".detectors must be a non-empty array");
      }
      return {
        type: "all_of",
        detectors: nested.map((item, i) => parseDetector(item, label + ".detectors[" + i + "]")),
      };
    }

    case "any_of": {
      const nested = expectArray(
        getRequired(detector, "detectors", label + ".detectors"),
        label + ".detectors",
      );
      if (nested.length === 0) {
        throw new Error(label + ".detectors must be a non-empty array");
      }
      return {
        type: "any_of",
        detectors: nested.map((item, i) => parseDetector(item, label + ".detectors[" + i + "]")),
      };
    }

    case "any_file_exists":
      return {
        type: "any_file_exists",
        paths: parseStringArray(
          getRequired(detector, "paths", label + ".paths"),
          label + ".paths",
        ),
      };

    case "codeowners_routing":
      return {
        type: "codeowners_routing",
        requireCodeowners: expectBool(detector["requireCodeowners"], label + ".requireCodeowners", true),
        maxUnownedFiles: detector["maxUnownedFiles"] != null
          ? expectUSize(detector["maxUnownedFiles"], label + ".maxUnownedFiles", 0)
          : undefined,
        maxSensitiveUnownedFiles: detector["maxSensitiveUnownedFiles"] != null
          ? expectUSize(detector["maxSensitiveUnownedFiles"], label + ".maxSensitiveUnownedFiles", 0)
          : undefined,
        maxOverlappingFiles: detector["maxOverlappingFiles"] != null
          ? expectUSize(detector["maxOverlappingFiles"], label + ".maxOverlappingFiles", 0)
          : undefined,
        requireTriggerAlignment: expectBool(
          detector["requireTriggerAlignment"],
          label + ".requireTriggerAlignment",
          false,
        ),
      };

    case "glob_count": {
      let patterns: string[];
      if (detector["patterns"] != null) {
        patterns = parseStringArray(detector["patterns"], label + ".patterns");
      } else {
        patterns = [expectString(
          getRequired(detector, "pattern", label + ".pattern"),
          label + ".pattern",
        )];
      }
      return {
        type: "glob_count",
        patterns,
        min: expectUSize(detector["min"], label + ".min", 1),
      };
    }

    case "glob_contains_regex": {
      const { pattern, flags } = parseRegexSettings(detector, label, "i");
      let patterns: string[];
      if (detector["patterns"] != null) {
        patterns = parseStringArray(detector["patterns"], label + ".patterns");
      } else {
        patterns = [expectString(
          getRequired(detector, "pattern_glob", label + ".pattern_glob"),
          label + ".pattern_glob",
        )];
      }
      return {
        type: "glob_contains_regex",
        patterns,
        pattern,
        flags,
        minMatches: expectUSize(detector["minMatches"], label + ".minMatches", 1),
      };
    }

    case "json_path_exists":
      return {
        type: "json_path_exists",
        path: expectString(getRequired(detector, "path", label + ".path"), label + ".path"),
        jsonPath: parsePathSpec(
          getRequired(detector, "jsonPath", label + ".jsonPath"),
          label + ".jsonPath",
        ),
      };

    case "yaml_path_exists":
      return {
        type: "yaml_path_exists",
        path: expectString(getRequired(detector, "path", label + ".path"), label + ".path"),
        yamlPath: parsePathSpec(
          getRequired(detector, "yamlPath", label + ".yamlPath"),
          label + ".yamlPath",
        ),
      };

    case "command_exit_code":
      return {
        type: "command_exit_code",
        command: expectString(getRequired(detector, "command", label + ".command"), label + ".command"),
        expectedExitCode: expectI32(detector["expectedExitCode"], label + ".expectedExitCode", 0),
        timeoutMs: expectU64(detector["timeoutMs"], label + ".timeoutMs", 10000),
      };

    case "command_output_regex": {
      const { pattern, flags } = parseRegexSettings(detector, label, "i");
      return {
        type: "command_output_regex",
        command: expectString(getRequired(detector, "command", label + ".command"), label + ".command"),
        pattern,
        flags,
        expectedExitCode: expectI32(detector["expectedExitCode"], label + ".expectedExitCode", 0),
        timeoutMs: expectU64(detector["timeoutMs"], label + ".timeoutMs", 10000),
      };
    }

    case "manual_attestation":
      return {
        type: "manual_attestation",
        prompt: expectString(getRequired(detector, "prompt", label + ".prompt"), label + ".prompt"),
      };

    default:
      throw new Error(label + ".type \"" + detectorType + "\" is not supported");
  }
}

function parseRegexSettings(
  detector: Record<string, unknown>,
  label: string,
  defaultFlags: string,
): { pattern: string; flags: string } {
  const pattern = expectString(
    getRequired(detector, "pattern", label + ".pattern"),
    label + ".pattern",
  );
  const flags = detector["flags"] != null
    ? (() => {
        const f = detector["flags"];
        if (typeof f !== "string") throw new Error(label + ".flags must be a string");
        return f;
      })()
    : defaultFlags;

  // Validate at parse time (matches Rust behavior)
  buildRegex(pattern, flags, label);

  return { pattern, flags };
}

function parsePathSpec(value: unknown, label: string): PathSegment[] {
  if (typeof value === "string") {
    const parts = value
      .split(".")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((segment): PathSegment => {
        const index = Number.parseInt(segment, 10);
        if (!Number.isNaN(index) && String(index) === segment) {
          return { kind: "index", value: index };
        }
        return { kind: "key", value: segment };
      });
    if (parts.length === 0) {
      throw new Error(label + " must be a non-empty path array or dotted string");
    }
    return parts;
  }

  const items = expectArray(value, label);
  if (items.length === 0) {
    throw new Error(label + " must be a non-empty path array or dotted string");
  }

  return items.map((segment): PathSegment => {
    if (typeof segment === "string") {
      if (segment.length === 0) {
        throw new Error(label + " contains an invalid segment");
      }
      return { kind: "key", value: segment };
    }
    if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) {
      return { kind: "index", value: segment };
    }
    throw new Error(label + " contains an invalid segment");
  });
}

function parseEvidenceMode(
  value: unknown,
  label: string,
  detectorRaw: unknown,
): EvidenceMode {
  if (value != null) {
    const str = expectString(value, label);
    switch (str) {
      case "static": return "static";
      case "runtime": return "runtime";
      case "hybrid": return "hybrid";
      case "manual": return "manual";
      case "ai":
      case "ai_only": return "ai";
      default:
        throw new Error(label + " must be one of static, runtime, hybrid, manual, ai");
    }
  }

  // Infer from detector type
  if (detectorRaw != null) {
    const detector = parseDetector(detectorRaw, label + ".detector_default");
    return defaultEvidenceMode(detector);
  }

  return "static";
}

/**
 * Determine the default evidence mode for a detector definition,
 * matching the Rust DetectorDefinition::default_evidence_mode().
 */
function defaultEvidenceMode(detector: DetectorDefinition): EvidenceMode {
  switch (detector.type) {
    case "file_exists":
    case "file_contains_regex":
    case "any_file_exists":
    case "codeowners_routing":
    case "glob_count":
    case "glob_contains_regex":
    case "json_path_exists":
    case "yaml_path_exists":
      return "static";
    case "command_exit_code":
    case "command_output_regex":
      return "runtime";
    case "manual_attestation":
      return "manual";
    case "all_of":
    case "any_of":
      return "hybrid";
  }
}

function parseAiCheck(value: unknown, label: string): FluencyAiCheck {
  const record = expectObject(value, label);
  const promptTemplate = expectString(
    getRequired(record, "prompt_template", label + ".prompt_template"),
    label + ".prompt_template",
  );
  const requires = record["requires"] != null
    ? parseStringArray(record["requires"], label + ".requires")
    : [];
  return { promptTemplate, requires };
}

// ---------------------------------------------------------------------------
// Primitive parsing helpers
// ---------------------------------------------------------------------------

function getRequired(
  object: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  if (!(key in object)) {
    throw new Error(label + " must be present");
  }
  return object[key];
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(label + " must be a non-empty array");
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(label + " must be a non-empty string");
  }
  return value.trim();
}

function expectBool(value: unknown, label: string, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(label + " must be a boolean");
  }
  return value;
}

function expectU32(value: unknown, label: string, defaultValue: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(label + " must be a number");
  }
  return value;
}

function expectUSize(value: unknown, label: string, defaultValue: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(label + " must be a number");
  }
  return value;
}

function expectI32(value: unknown, label: string, defaultValue: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(label + " must be a number");
  }
  return value;
}

function expectU64(value: unknown, label: string, defaultValue: number): number {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(label + " must be a number");
  }
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  const items = expectArray(value, label);
  if (items.length === 0) {
    throw new Error(label + " must be a non-empty array");
  }
  return items.map((item, i) => expectString(item, label + "[" + i + "]"));
}
