import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeDependencyGraph,
  extractJavaImports,
  extractRustUses,
  extractTypeScriptImports,
} from "../dependency-graph-analyzer";

const tempRoots: string[] = [];

function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-analyzer-"));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents, "utf8");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("extractTypeScriptImports", () => {
  it("collects static import, export-from, side-effect, and type imports", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "@/core/b";',
      'import "./side-effect";',
      'export { c } from "../c";',
      'export type { D } from "lib-d";',
      'const lazy = () => import("./dynamic");',
      "// import ghost from \"ghost\";",
      "/* import phantom from \"phantom\"; */",
      "",
    ].join("\n");

    expect(extractTypeScriptImports(source)).toEqual([
      "../c",
      "./a",
      "./side-effect",
      "@/core/b",
      "lib-d",
    ]);
  });
});

describe("extractRustUses", () => {
  it("collects use declarations including pub use and brace groups", () => {
    const source = [
      "use std::collections::BTreeMap;",
      "pub use crate::graph::{analyze_directory, AnalysisLang};",
      "use serde::Serialize as Serde;",
      "",
    ].join("\n");

    expect(extractRustUses(source)).toEqual([
      "crate::graph::{analyze_directory, AnalysisLang}",
      "serde::Serialize as Serde",
      "std::collections::BTreeMap",
    ]);
  });
});

describe("extractJavaImports", () => {
  it("collects import declarations including static imports", () => {
    const source = [
      "package com.example;",
      "import java.util.List;",
      "import static org.junit.Assert.assertEquals;",
      "import com.example.other.Helper;",
      "",
    ].join("\n");

    expect(extractJavaImports(source)).toEqual([
      "com.example.other.Helper",
      "java.util.List",
      "org.junit.Assert.assertEquals",
    ]);
  });
});

describe("analyzeDependencyGraph (typescript)", () => {
  it("builds file nodes and resolves relative, alias, index, and external imports", () => {
    const root = makeTempRepo();
    writeFile(
      root,
      "src/entry.ts",
      [
        'import { helper } from "./lib/helper";',
        'import { aliased } from "@/core/aliased";',
        'import { indexed } from "./lib/dir";',
        'import missing from "./nope";',
        'import { z } from "zod";',
        'import fs from "node:fs";',
        'import styles from "@scope/pkg/sub";',
        "",
      ].join("\n"),
    );
    writeFile(root, "src/lib/helper.ts", "export const helper = 1;\n");
    writeFile(root, "src/core/aliased.ts", "export const aliased = 1;\n");
    writeFile(root, "src/lib/dir/index.ts", "export const indexed = 1;\n");

    const graph = analyzeDependencyGraph(root, "typescript", "fast");

    expect(graph.language).toBe("typescript");
    expect(graph.root_dir).toBe(root);
    expect(graph.node_count).toBe(graph.nodes.length);
    expect(graph.edge_count).toBe(graph.edges.length);

    const nodeIds = graph.nodes.map((node) => node.id);
    expect(nodeIds).toContain("src/entry.ts");
    expect(nodeIds).toContain("src/lib/helper.ts");
    expect(nodeIds).toContain("src/core/aliased.ts");
    expect(nodeIds).toContain("src/lib/dir/index.ts");
    expect(nodeIds).toContain("zod");
    expect(nodeIds).toContain("node:fs");
    expect(nodeIds).toContain("@scope/pkg");
    expect(nodeIds).toContain("./nope");

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.get("src/entry.ts")?.kind).toBe("file");
    expect(byId.get("zod")?.kind).toBe("external_package");
    expect(byId.get("node:fs")?.kind).toBe("external_package");
    expect(byId.get("@scope/pkg")?.kind).toBe("external_package");
    expect(byId.get("./nope")?.kind).toBe("unresolved_module");
    expect(byId.get("src/lib/helper.ts")?.language).toBe("typescript");

    const edgeKeys = graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.resolved}`);
    expect(edgeKeys).toEqual([
      "src/entry.ts->./nope:false",
      "src/entry.ts->@scope/pkg:false",
      "src/entry.ts->node:fs:false",
      "src/entry.ts->src/core/aliased.ts:true",
      "src/entry.ts->src/lib/dir/index.ts:true",
      "src/entry.ts->src/lib/helper.ts:true",
      "src/entry.ts->zod:false",
    ]);
    expect(graph.edges.every((edge) => edge.kind === "imports")).toBe(true);
    const resolvedSpecifier = graph.edges.find(
      (edge) => edge.to === "src/lib/helper.ts",
    )?.specifier;
    expect(resolvedSpecifier).toBe("./lib/helper");
  });

  it("skips ignored directories", () => {
    const root = makeTempRepo();
    writeFile(root, "src/entry.ts", 'import { x } from "./hidden";\n');
    writeFile(root, "node_modules/dep/index.ts", "export const x = 1;\n");

    const graph = analyzeDependencyGraph(root, "auto", "fast");

    const nodeIds = graph.nodes.map((node) => node.id);
    expect(nodeIds).toEqual(["./hidden", "src/entry.ts"]);
  });
});

describe("analyzeDependencyGraph (rust)", () => {
  it("resolves crate, self, sibling crates, and external crates", () => {
    const root = makeTempRepo();
    writeFile(
      root,
      "crates/alpha/Cargo.toml",
      ['[package]', 'name = "alpha-core"', ""].join("\n"),
    );
    writeFile(
      root,
      "crates/alpha/src/lib.rs",
      [
        "pub mod util;",
        "use crate::util;",
        "use self::util as u2;",
        "use alpha_core;",
        "use std::collections::BTreeMap;",
        "use serde::Serialize;",
        "",
      ].join("\n"),
    );
    writeFile(root, "crates/alpha/src/util.rs", "pub fn util() {}\n");

    const graph = analyzeDependencyGraph(root, "rust", "fast");

    const edgeTargets = graph.edges.map((edge) => `${edge.to}:${edge.kind}:${edge.resolved}`);
    expect(edgeTargets).toEqual([
      "crates/alpha/src/lib.rs:uses:true",
      "crates/alpha/src/util.rs:uses:true",
      "crates/alpha/src/util.rs:uses:true",
      "serde:uses:false",
      "std:uses:false",
    ]);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.get("serde")?.kind).toBe("external_crate");
    expect(byId.get("std")?.kind).toBe("external_crate");
    expect(byId.get("crates/alpha/src/util.rs")?.language).toBe("rust");
  });
});

describe("analyzeDependencyGraph (java)", () => {
  it("resolves local package files and externalizes JDK imports", () => {
    const root = makeTempRepo();
    writeFile(
      root,
      "src/main/java/com/example/App.java",
      [
        "package com.example;",
        "import java.util.List;",
        "import com.example.util.Helper;",
        "",
        "public class App {}",
        "",
      ].join("\n"),
    );
    writeFile(
      root,
      "src/main/java/com/example/util/Helper.java",
      ["package com.example.util;", "public class Helper {}", ""].join("\n"),
    );

    const graph = analyzeDependencyGraph(root, "java", "fast");

    const edgeTargets = graph.edges.map((edge) => `${edge.to}:${edge.resolved}`);
    expect(edgeTargets).toEqual([
      "java:false",
      "src/main/java/com/example/util/Helper.java:true",
    ]);
  });
});
