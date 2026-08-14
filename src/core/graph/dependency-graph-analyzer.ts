/**
 * TypeScript port of the routa-cli fast-mode dependency graph engine
 * (`crates/routa-cli/src/commands/graph/analyze.rs`, AnalysisDepth::Fast).
 *
 * Produces the same JSON shape the Rust CLI emitted for
 * `routa graph analyze --depth fast -f json`: file-level nodes plus
 * import/use edges with resolution metadata. Symbol-level "normal"
 * depth was only ever exercised by the Rust CLI itself; the Web graph
 * view always requests depth=fast, so both depths map to the
 * file-level analysis in the Web-only port.
 */

import fs from "node:fs";
import path from "node:path";

export type GraphAnalysisLanguage = "auto" | "rust" | "typescript" | "java";
export type GraphAnalysisDepth = "fast" | "normal";

export type GraphAnalyzerNodeKind =
  | "file"
  | "external_crate"
  | "external_package"
  | "unresolved_module";

export type GraphAnalyzerEdgeKind = "uses" | "imports";

export type GraphAnalyzerNode = {
  id: string;
  path: string;
  language: string;
  kind: GraphAnalyzerNodeKind;
};

export type GraphAnalyzerEdge = {
  from: string;
  to: string;
  kind: GraphAnalyzerEdgeKind;
  specifier: string;
  resolved: boolean;
};

export type GraphAnalyzerResult = {
  generated_at: string;
  root_dir: string;
  language: string;
  node_count: number;
  edge_count: number;
  nodes: GraphAnalyzerNode[];
  edges: GraphAnalyzerEdge[];
};

type InternalLang = "rust" | "typescript" | "java";

type ResolvedTarget =
  | { status: "local"; relativePath: string }
  | { status: "external"; nodeKind: "external_crate" | "external_package"; id: string }
  | { status: "unresolved"; id: string };

type RustCrate = {
  srcDir: string;
  entryPath: string;
};

type RustWorkspaceContext = {
  crates: RustCrate[];
  importRoots: Map<string, string>;
};

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".routa",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".d.ts"];

const RESOLVE_INDEX_FILES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.d.ts",
];

export function analyzeDependencyGraph(
  rootDir: string,
  language: GraphAnalysisLanguage,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  depth: GraphAnalysisDepth,
): GraphAnalyzerResult {
  const nodes = new Map<string, GraphAnalyzerNode>();
  const edges = new Map<string, GraphAnalyzerEdge>();
  const rustWorkspace =
    language === "rust" || language === "auto"
      ? buildRustWorkspaceContext(rootDir)
      : { crates: [], importRoots: new Map<string, string>() };

  walkFiles(rootDir, (absolutePath) => {
    const effectiveLang = effectiveLanguageForPath(absolutePath, language);
    if (!effectiveLang) {
      return;
    }

    const relativePath = repoRelativePath(rootDir, absolutePath);
    const languageLabel = displayLanguage(effectiveLang);
    if (!nodes.has(relativePath)) {
      nodes.set(relativePath, {
        id: relativePath,
        path: relativePath,
        language: languageLabel,
        kind: "file",
      });
    }

    let source: string;
    try {
      source = fs.readFileSync(absolutePath, "utf8");
    } catch {
      return;
    }

    const specifiers =
      effectiveLang === "rust"
        ? extractRustUses(source)
        : effectiveLang === "typescript"
          ? extractTypeScriptImports(source)
          : extractJavaImports(source);

    for (const specifier of specifiers) {
      const resolved =
        effectiveLang === "rust"
          ? resolveRustDependency(rootDir, absolutePath, specifier, rustWorkspace)
          : effectiveLang === "typescript"
            ? resolveTypeScriptDependency(rootDir, absolutePath, specifier)
            : resolveJavaDependency(rootDir, specifier);

      const targetId = resolved.status === "local" ? resolved.relativePath : resolved.id;
      const targetKind: GraphAnalyzerNodeKind =
        resolved.status === "local"
          ? "file"
          : resolved.status === "external"
            ? resolved.nodeKind
            : "unresolved_module";

      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          path: targetId,
          language: languageLabel,
          kind: targetKind,
        });
      }

      const edgeKind: GraphAnalyzerEdgeKind = effectiveLang === "rust" ? "uses" : "imports";
      const resolvedFlag = resolved.status === "local";
      const edgeKey = `${relativePath}\u0000${targetId}\u0000${edgeKind}\u0000${specifier}\u0000${resolvedFlag}`;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          from: relativePath,
          to: targetId,
          kind: edgeKind,
          specifier,
          resolved: resolvedFlag,
        });
      }
    }
  });

  const sortedNodes = [...nodes.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const sortedEdges = [...edges.values()].sort((left, right) => {
    const byFrom = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
    if (byFrom !== 0) return byFrom;
    const byTo = left.to < right.to ? -1 : left.to > right.to ? 1 : 0;
    if (byTo !== 0) return byTo;
    const byKind = left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
    if (byKind !== 0) return byKind;
    const bySpecifier =
      left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0;
    if (bySpecifier !== 0) return bySpecifier;
    return Number(left.resolved) - Number(right.resolved);
  });

  return {
    generated_at: new Date().toISOString(),
    root_dir: rootDir,
    language,
    node_count: sortedNodes.length,
    edge_count: sortedEdges.length,
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

// ─── Traversal ──────────────────────────────────────────────────────────────

function walkFiles(rootDir: string, visit: (absolutePath: string) => void): void {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SEGMENTS.has(entry.name)) {
          stack.push(entryPath);
        }
      } else if (entry.isFile()) {
        if (!isIgnoredSegmentPath(entryPath, rootDir)) {
          visit(entryPath);
        }
      }
    }
  }
}

function isIgnoredSegmentPath(absolutePath: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, absolutePath);
  return relative.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

function effectiveLanguageForPath(
  absolutePath: string,
  requested: GraphAnalysisLanguage,
): InternalLang | null {
  const extension = path.extname(absolutePath);
  switch (requested) {
    case "rust":
      return extension === ".rs" ? "rust" : null;
    case "typescript":
      return TYPESCRIPT_EXTENSIONS.has(extension) ? "typescript" : null;
    case "java":
      return extension === ".java" ? "java" : null;
    case "auto":
      if (extension === ".rs") return "rust";
      if (TYPESCRIPT_EXTENSIONS.has(extension)) return "typescript";
      if (extension === ".java") return "java";
      return null;
  }
}

function displayLanguage(lang: InternalLang): string {
  return lang;
}

function repoRelativePath(rootDir: string, absolutePath: string): string {
  const relative = path.relative(rootDir, absolutePath);
  return relative.length === 0 ? path.basename(absolutePath) : relative.split(path.sep).join("/");
}

// ─── TypeScript extraction / resolution ────────────────────────────────────

function stripComments(source: string): string {
  let output = "";
  let index = 0;
  let stringChar: string | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (stringChar) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === stringChar) {
        stringChar = null;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      stringChar = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

export function extractTypeScriptImports(source: string): string[] {
  const stripped = stripComments(source);
  const specifiers = new Set<string>();
  const patterns = [
    // import ... from "specifier" (including `import type`)
    /\bimport\b(?:[^;"'`]|"[^"]*"|'[^']*'|`[^`]*`)*?\bfrom\s*["']([^"']+)["']/g,
    // side-effect import "specifier"
    /\bimport\s*["']([^"']+)["']/g,
    // export ... from "specifier" (including `export type`)
    /\bexport\b(?:[^;"'`]|"[^"]*"|'[^']*'|`[^`]*`)*?\bfrom\s*["']([^"']+)["']/g,
    // import alias = require("specifier")
    /\bimport\b[^;]*?=\s*require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers].sort();
}

function resolveTypeScriptDependency(
  rootDir: string,
  importer: string,
  specifier: string,
): ResolvedTarget {
  let candidate: string | null = null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    candidate = path.normalize(path.join(path.dirname(importer), specifier));
  } else if (specifier.startsWith("@/")) {
    candidate = path.normalize(path.join(rootDir, "src", specifier.slice("@/".length)));
  }

  if (candidate) {
    const resolved = resolveTypeScriptLocalCandidate(candidate);
    if (resolved) {
      return { status: "local", relativePath: repoRelativePath(rootDir, resolved) };
    }
    return { status: "unresolved", id: specifier };
  }

  return {
    status: "external",
    nodeKind: "external_package",
    id: packageIdFromSpecifier(specifier),
  };
}

function resolveTypeScriptLocalCandidate(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  if (!path.extname(candidate)) {
    for (const extension of RESOLVE_EXTENSIONS) {
      const resolved = `${candidate}${extension}`;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    }
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const indexFile of RESOLVE_INDEX_FILES) {
      const resolved = path.join(candidate, indexFile);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    }
  }

  return null;
}

function packageIdFromSpecifier(specifier: string): string {
  if (specifier.startsWith("node:")) {
    return specifier;
  }
  if (specifier.startsWith("@")) {
    const segments = specifier.slice(1).split("/");
    if (segments.length >= 2) {
      return `@${segments[0]}/${segments[1]}`;
    }
  }
  return specifier.split("/")[0] ?? specifier;
}

// ─── Rust extraction / resolution ───────────────────────────────────────────

export function extractRustUses(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/^[ \t]*(?:pub[ \t]+)?use[ \t]+([^;]+);/gm)) {
    const raw = match[1]?.trim();
    if (raw) {
      specifiers.add(raw);
    }
  }
  return [...specifiers].sort();
}

function normalizeRustUseSpecifier(specifier: string): string {
  let value = specifier.trim().replace(/^::/, "");
  const aliasIndex = value.indexOf(" as ");
  if (aliasIndex !== -1) {
    value = value.slice(0, aliasIndex).trim();
  }
  const braceIndex = value.indexOf("{");
  if (braceIndex !== -1) {
    value = value.slice(0, braceIndex).replace(/:+$/, "").trim();
  }
  return value;
}

function buildRustWorkspaceContext(rootDir: string): RustWorkspaceContext {
  const crates: RustCrate[] = [];
  const importRoots = new Map<string, string>();

  walkFiles(rootDir, (absolutePath) => {
    if (path.basename(absolutePath) !== "Cargo.toml") {
      return;
    }
    let contents: string;
    try {
      contents = fs.readFileSync(absolutePath, "utf8");
    } catch {
      return;
    }
    const packageName = parseCargoPackageName(contents);
    if (!packageName) {
      return;
    }
    const crateDir = path.dirname(absolutePath);
    const srcDir = path.join(crateDir, "src");
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      return;
    }
    const entryFile = ["lib.rs", "main.rs"]
      .map((name) => path.join(srcDir, name))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!entryFile) {
      return;
    }
    const importRoot = packageName.replaceAll("-", "_");
    const entryPath = repoRelativePath(rootDir, entryFile);
    importRoots.set(importRoot, entryPath);
    crates.push({ srcDir, entryPath });
  });

  crates.sort(
    (left, right) =>
      right.srcDir.split(path.sep).length - left.srcDir.split(path.sep).length,
  );
  return { crates, importRoots };
}

function parseCargoPackageName(contents: string): string | null {
  let inPackage = false;
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    if (!inPackage || !trimmed.startsWith("name")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1);
    }
  }
  return null;
}

function rustModuleSegments(importer: string, crate: RustCrate): string[] {
  const relative = path.relative(crate.srcDir, importer);
  if (relative.startsWith("..")) {
    return [];
  }
  const fileName = path.basename(relative);
  if (fileName === "lib.rs" || fileName === "main.rs") {
    return [];
  }
  const segments = relative.split(path.sep);
  if (fileName === "mod.rs") {
    return segments.slice(0, -1);
  }
  return [...segments.slice(0, -1), fileName.replace(/\.rs$/, "")];
}

function resolveRustModulePath(
  rootDir: string,
  crate: RustCrate,
  baseSegments: string[],
  rest: string,
): string | null {
  const segments = [
    ...baseSegments,
    ...rest.split("::").filter((segment) => segment.length > 0),
  ];
  if (segments.length === 0) {
    return crate.entryPath;
  }
  for (let length = segments.length; length >= 1; length -= 1) {
    const moduleBase = path.join(crate.srcDir, ...segments.slice(0, length));
    for (const candidate of [`${moduleBase}.rs`, path.join(moduleBase, "mod.rs")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return repoRelativePath(rootDir, candidate);
      }
    }
  }
  return null;
}

function resolveRustDependency(
  rootDir: string,
  importer: string,
  specifier: string,
  workspace: RustWorkspaceContext,
): ResolvedTarget {
  const normalized = normalizeRustUseSpecifier(specifier);
  if (!normalized) {
    return { status: "unresolved", id: specifier };
  }

  const owningCrate = workspace.crates.find((crate) =>
    importer.startsWith(crate.srcDir + path.sep),
  );

  if (owningCrate) {
    if (normalized === "crate") {
      return { status: "local", relativePath: owningCrate.entryPath };
    }
    if (normalized.startsWith("crate::")) {
      const resolved = resolveRustModulePath(
        rootDir,
        owningCrate,
        [],
        normalized.slice("crate::".length),
      );
      if (resolved) {
        return { status: "local", relativePath: resolved };
      }
    }
    if (normalized.startsWith("self::")) {
      const base = rustModuleSegments(importer, owningCrate);
      const resolved = resolveRustModulePath(
        rootDir,
        owningCrate,
        base,
        normalized.slice("self::".length),
      );
      if (resolved) {
        return { status: "local", relativePath: resolved };
      }
    }
    if (normalized.startsWith("super::")) {
      const base = rustModuleSegments(importer, owningCrate);
      let rest = normalized;
      while (rest.startsWith("super::")) {
        if (base.length > 0) {
          base.pop();
        }
        rest = rest.slice("super::".length);
      }
      const resolved = resolveRustModulePath(rootDir, owningCrate, base, rest);
      if (resolved) {
        return { status: "local", relativePath: resolved };
      }
    }
    const resolved = resolveRustModulePath(rootDir, owningCrate, [], normalized);
    if (resolved) {
      return { status: "local", relativePath: resolved };
    }
  }

  const firstSegment = normalized.split("::")[0] ?? "";
  const importRoot = workspace.importRoots.get(firstSegment);
  if (importRoot) {
    return { status: "local", relativePath: importRoot };
  }
  if (firstSegment) {
    return { status: "external", nodeKind: "external_crate", id: firstSegment };
  }
  return { status: "unresolved", id: specifier };
}

// ─── Java extraction / resolution ───────────────────────────────────────────

export function extractJavaImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w$.]+)[ \t]*;/gm)) {
    const raw = match[1]?.trim();
    if (raw) {
      specifiers.add(raw);
    }
  }
  return [...specifiers].sort();
}

function resolveJavaDependency(rootDir: string, specifier: string): ResolvedTarget {
  if (specifier.startsWith("java.") || specifier.startsWith("javax.")) {
    return {
      status: "external",
      nodeKind: "external_package",
      id: specifier.split(".")[0] ?? specifier,
    };
  }

  const parts = specifier.split(".");
  const className = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  for (const srcRoot of ["src/main/java", "src", "."]) {
    const candidate = path.join(rootDir, srcRoot, ...dirParts, `${className}.java`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { status: "local", relativePath: repoRelativePath(rootDir, candidate) };
    }
  }

  return {
    status: "external",
    nodeKind: "external_package",
    id: parts[0] ?? specifier,
  };
}
