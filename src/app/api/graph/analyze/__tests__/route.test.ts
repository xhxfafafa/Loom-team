import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../route";

const tempRoots: string[] = [];

function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-analyze-route-"));
  tempRoots.push(root);
  return root;
}

function get(url: string): Promise<Response> {
  return GET(new Request(url));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("GET /api/graph/analyze", () => {
  it("returns 400 when repoRoot is missing", async () => {
    const res = await get("http://localhost/api/graph/analyze");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repoRoot parameter is required" });
  });

  it("returns 400 when the directory does not exist", async () => {
    const res = await get(
      "http://localhost/api/graph/analyze?repoRoot=/definitely/not/a/dir",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Directory does not exist: /definitely/not/a/dir",
    });
  });

  it("returns 400 for an unknown language", async () => {
    const root = makeTempRepo();
    const res = await get(
      `http://localhost/api/graph/analyze?repoRoot=${encodeURIComponent(root)}&lang=kotlin`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Failed to analyze dependency graph");
    expect(body.details).toContain("invalid lang 'kotlin'");
  });

  it("returns 400 for an unknown depth", async () => {
    const root = makeTempRepo();
    const res = await get(
      `http://localhost/api/graph/analyze?repoRoot=${encodeURIComponent(root)}&depth=ultra`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details).toContain("invalid depth 'ultra'");
  });

  it("analyzes a TypeScript tree with defaults (auto, fast)", async () => {
    const root = makeTempRepo();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "main.ts"),
      'import { util } from "./util";\nimport { z } from "zod";\n',
      "utf8",
    );
    fs.writeFileSync(path.join(root, "src", "util.ts"), "export const util = 1;\n", "utf8");

    const res = await get(
      `http://localhost/api/graph/analyze?repoRoot=${encodeURIComponent(root)}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.root_dir).toBe(root);
    expect(body.language).toBe("auto");
    expect(typeof body.generated_at).toBe("string");
    expect(body.node_count).toBe(body.nodes.length);
    expect(body.edge_count).toBe(body.edges.length);

    const nodeIds = body.nodes.map((node: { id: string }) => node.id);
    expect(nodeIds).toContain("src/main.ts");
    expect(nodeIds).toContain("src/util.ts");
    expect(nodeIds).toContain("zod");

    const resolvedEdge = body.edges.find(
      (edge: { to: string }) => edge.to === "src/util.ts",
    );
    expect(resolvedEdge).toMatchObject({
      from: "src/main.ts",
      kind: "imports",
      specifier: "./util",
      resolved: true,
    });
  });

  it("accepts the ts language alias", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "a.ts"), 'import "./b";\n', "utf8");
    fs.writeFileSync(path.join(root, "b.tsx"), "export default 1;\n", "utf8");

    const res = await get(
      `http://localhost/api/graph/analyze?repoRoot=${encodeURIComponent(root)}&lang=ts`,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.language).toBe("typescript");
    expect(
      body.edges.some(
        (edge: { to: string; resolved: boolean }) =>
          edge.to === "b.tsx" && edge.resolved === true,
      ),
    ).toBe(true);
  });
});
