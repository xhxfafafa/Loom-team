/**
 * Type definitions for module dependency graph analysis.
 * Matches the output of the TypeScript dependency graph analyzer
 * (src/core/graph/dependency-graph-analyzer.ts), which performs
 * file-level (fast) analysis.
 */

export type NodeKind =
  | "file"
  | "external_crate"
  | "external_package"
  | "unresolved_module";

export type EdgeKind = "uses" | "imports";

export type GraphLanguage = "rust" | "typescript" | "java" | "auto";

export interface GraphNode {
  id: string;
  path: string;
  language: string;
  kind: NodeKind;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  specifier: string;
  resolved: boolean;
}

export interface DependencyGraph {
  generated_at: string;
  root_dir: string;
  language: string;
  node_count: number;
  edge_count: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphAnalyzeParams {
  repoRoot: string;
  language?: GraphLanguage;
  depth?: "fast" | "normal";
}
