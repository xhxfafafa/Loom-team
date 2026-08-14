/**
 * API endpoint for module dependency graph analysis.
 *
 * Web-only port: the analysis now runs in-process through the
 * TypeScript dependency graph analyzer instead of spawning
 * `routa graph analyze`. The response shape is unchanged.
 */

import { NextResponse } from "next/server";
import { existsSync } from "fs";
import {
  analyzeDependencyGraph,
  type GraphAnalysisDepth,
  type GraphAnalysisLanguage,
} from "@/core/graph/dependency-graph-analyzer";

const LANGUAGE_ALIASES: Record<string, GraphAnalysisLanguage> = {
  auto: "auto",
  rust: "rust",
  typescript: "typescript",
  ts: "typescript",
  java: "java",
};

const DEPTHS: Record<string, GraphAnalysisDepth> = {
  fast: "fast",
  normal: "normal",
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const repoRoot = searchParams.get("repoRoot");
    const langParam = searchParams.get("lang") || "auto";
    const depthParam = searchParams.get("depth") || "fast";

    if (!repoRoot) {
      return NextResponse.json(
        { error: "repoRoot parameter is required" },
        { status: 400 }
      );
    }

    if (!existsSync(repoRoot)) {
      return NextResponse.json(
        { error: `Directory does not exist: ${repoRoot}` },
        { status: 400 }
      );
    }

    const language = LANGUAGE_ALIASES[langParam];
    if (!language) {
      return NextResponse.json(
        {
          error: "Failed to analyze dependency graph",
          details: `invalid lang '${langParam}' (expected auto, rust, typescript, or java)`,
        },
        { status: 400 }
      );
    }

    const depth = DEPTHS[depthParam];
    if (!depth) {
      return NextResponse.json(
        {
          error: "Failed to analyze dependency graph",
          details: `invalid depth '${depthParam}' (expected fast or normal)`,
        },
        { status: 400 }
      );
    }

    const graph = analyzeDependencyGraph(repoRoot, language, depth);
    return NextResponse.json(graph);
  } catch (error) {
    console.error("[graph/analyze] Unexpected error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
