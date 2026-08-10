/**
 * Team Execution Chain presets.
 *
 * A "chain" is an orchestration policy for a Team Run: how many delivery
 * stages, child agents, and verification gates are expected. A chain is NOT a
 * specialist — the root session keeps `specialistId: "team-agent-lead"` and
 * gains an optional `teamChainId` metadata field instead.
 *
 * Storage semantics:
 * - JSON field name: `teamChainId`; persistence column: `team_chain_id`.
 * - Omitted/legacy values stay NULL in storage and are *interpreted* as
 *   `full_delivery` when reading or displaying. The distinction between an
 *   explicitly selected Full Delivery run and a legacy run is preserved.
 *
 * This module is shared by the TypeScript backend and the client UI. It must
 * stay pure (no Node/DOM imports). The Rust backend implements the same
 * semantics separately; API-parity tests keep the two aligned.
 */

import { TEAM_LEAD_SPECIALIST_ID } from "./team-run-identity";

export const TEAM_CHAIN_IDS = ["lightweight", "standard_delivery", "full_delivery"] as const;

/** Valid Team execution chain identifiers. */
export type TeamChainId = (typeof TEAM_CHAIN_IDS)[number];

/** Legacy/omitted Team Runs behave as Full Delivery. */
export const DEFAULT_TEAM_CHAIN_ID: TeamChainId = "full_delivery";

/** Type guard for the three known chain identifiers. */
export function isTeamChainId(value: unknown): value is TeamChainId {
  return typeof value === "string" && (TEAM_CHAIN_IDS as readonly string[]).includes(value);
}

/**
 * Normalize a raw persisted/request value: a valid chain ID passes through,
 * anything else (including null/undefined) becomes `null`, meaning
 * "omitted — interpret as legacy Full Delivery".
 */
export function parseTeamChainId(value: unknown): TeamChainId | null {
  return isTeamChainId(value) ? value : null;
}

/** Interpret an omitted/legacy value as the default chain. */
export function resolveEffectiveTeamChainId(value: TeamChainId | null | undefined): TeamChainId {
  return value ?? DEFAULT_TEAM_CHAIN_ID;
}

/**
 * Validate a `session/new` chain assignment.
 *
 * Rules (mirrored by the Rust backend):
 * - an omitted `teamChainId` is always allowed and persists as NULL;
 * - a provided value must be one of the three known IDs;
 * - `teamChainId` is only allowed on a top-level `team-agent-lead` session.
 */
export function validateTeamChainAssignment(input: {
  teamChainId?: unknown;
  specialistId?: string | null;
  parentSessionId?: string | null;
}): { ok: true; teamChainId: TeamChainId | null } | { ok: false; reason: TeamChainValidationError } {
  const raw = input.teamChainId;
  if (raw === undefined || raw === null) {
    return { ok: true, teamChainId: null };
  }
  if (!isTeamChainId(raw)) {
    return { ok: false, reason: "invalid_value" };
  }
  if (input.specialistId !== TEAM_LEAD_SPECIALIST_ID) {
    return { ok: false, reason: "requires_team_lead" };
  }
  if (input.parentSessionId) {
    return { ok: false, reason: "requires_root_session" };
  }
  return { ok: true, teamChainId: raw };
}

export type TeamChainValidationError =
  | "invalid_value"
  | "requires_team_lead"
  | "requires_root_session";

const LIGHTWEIGHT_POLICY = `## Team Chain Policy: Lightweight

This Team Run uses the Lightweight execution chain. Where this policy differs from the default full-delivery rules in your role prompt, this policy wins.

- Delivery stages: Team Lead -> one implementation specialist -> Team Lead delivery.
- Child agent shape: delegate to at most ONE child agent in total. No research wave, no parallel waves, no multi-specialist pipeline.
- Verification: the single implementer verifies their own work with targeted evidence (focused tests, build, or a scoped manual check). Self-verification is valid evidence on this chain — do NOT spawn an independent QA or code-review agent.
- Stop and escalate: if the work grows beyond one bounded change, needs another specialty, touches public APIs, database schema or migrations, security, payments, or needs broader verification — stop expanding, explain the newly discovered scope or risk, recommend a stronger chain, and ask the user to start a new Team Run with it.
- Completion output: what changed, how the implementer verified it (concrete evidence), and any risks or follow-ups found.`;

const STANDARD_DELIVERY_POLICY = `## Team Chain Policy: Standard Delivery

This Team Run uses the Standard Delivery execution chain. Where this policy differs from the default full-delivery rules in your role prompt, this policy wins.

- Delivery stages: Team Lead -> one primary implementer -> one independent verifier -> Team Lead delivery.
- Child agent shape: exactly one primary implementation specialist; at most two child sessions active at once. Do not open with a research wave; add research only if the affected area cannot be identified safely by the primary implementer.
- Verification: after implementation, run exactly ONE independent verification stage. Choose the verifier deterministically: behavior or UI changes -> qa; code-structure or interface changes -> code-reviewer; when both apply -> qa. The verifier must produce concrete evidence (test output, inspection results), not a generic approval.
- Stop and escalate: if risk expands (database schema or migrations, security, payments, cross-backend delivery, public APIs) or scope grows beyond one primary change — stop expanding, explain the newly discovered scope or risk, recommend a stronger chain, and ask the user to start a new Team Run with it.
- Completion output: what changed, which independent verifier checked it, and the verification evidence.`;

/**
 * Resolve a chain ID into the concise policy prompt appended to the Team Lead
 * specialist prompt.
 *
 * `full_delivery` and legacy/omitted values return `null`: the canonical
 * Agent Lead rules already encode Full Delivery, so nothing is appended and
 * legacy runs keep their exact historical prompt.
 */
export function buildTeamChainPolicyPrompt(chainId: TeamChainId | null | undefined): string | null {
  switch (chainId) {
    case "lightweight":
      return LIGHTWEIGHT_POLICY;
    case "standard_delivery":
      return STANDARD_DELIVERY_POLICY;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic chain recommendation (advisory, local, no model calls).
// ---------------------------------------------------------------------------

export type TeamChainRecommendationReason =
  | "high_risk"
  | "bounded_scope"
  | "standard_task"
  | "analysis_only";

export interface TeamChainRecommendation {
  chainId: TeamChainId;
  /** Stable key used by the UI to localize the recommendation reason. */
  reason: TeamChainRecommendationReason;
  /**
   * True when the request reads as analysis-only. The MVP has no enforced
   * read-only Team chain, so the UI must surface this instead of pretending
   * the run will be non-mutating.
   */
  analysisOnly: boolean;
}

const HIGH_RISK_PATTERNS: RegExp[] = [
  // database migrations / schema changes
  /\b(?:db|database)\s+migrat(?:e|es|ion|ions)\b/i,
  /\bmigrat(?:e|ion|ions)\b[^\n]{0,40}\b(?:db|database|schema|table)\b/i,
  /\b(?:db|database|schema|table)\b[^\n]{0,40}\bmigrat(?:e|ion|ions)\b/i,
  /\bschema\s+(?:change|changes|migration|migrations|update)\b/i,
  /数据库迁移|数据迁移|迁移脚本|表结构变更|建表/,
  // permissions / authorization / authentication
  /\b(?:authz|authn|rbac|access[- ]control)\b/i,
  /\bauth(?:orization|orize|entication)?\b/i,
  /\bpermissions?\b/i,
  /权限|授权|认证|鉴权|访问控制/,
  // security
  /\b(?:security|secure|vulnerabilit(?:y|ies)|exploit|cve|encryption)\b/i,
  /安全|漏洞|加密/,
  // payment / billing
  /\b(?:payments?|billing|checkout|refunds?|invoices?|subscriptions?)\b/i,
  /支付|付款|账单|退款|计费|开票/,
  // public API / breaking changes
  /\bpublic\s+apis?\b/i,
  /\bbreaking\s+changes?\b/i,
  /公开接口|对外接口|开放接口|破坏性变更/,
  // cross-backend delivery
  /\bcross[- ]backend\b/i,
  /\bboth\s+(?:the\s+)?backends?\b/i,
  /\b(?:web\s+and\s+desktop|desktop\s+and\s+web)\b/i,
  /\b(?:typescript|rust)\s+and\s+(?:typescript|rust)\b/i,
  /双端|两个后端|前后端同时/,
];

const VISUAL_QUALIFIER_PATTERNS: RegExp[] = [
  /\b(?:css|styles?|styling|colou?rs?|fonts?|icons?|spacing|padding|margins?|alignment|align|borders?|radius|shadows?|layouts?|animations?|transitions?|visual)\b/i,
  /\blooks?\s+and\s+feel\b/i,
  /样式|颜色|字体|图标|间距|对齐|边框|圆角|阴影|布局|视觉|排版|动画|美观/,
];

const STRUCTURAL_PATTERNS: RegExp[] = [
  /\b(?:apis?|endpoints?|interfaces?|logic|flows?|backend|database|schema|servers?|protocols?|contracts?)\b/i,
  /逻辑|接口|流程|后端|数据库|协议|服务端/,
];

const EXPANSIVE_PATTERNS: RegExp[] = [
  /\b(?:redesign|overhaul|entire|whole|system[- ]wide)\b/i,
  /\ball\s+(?:the\s+)?(?:pages|components|views|screens)\b/i,
  /整体|全面|重新设计|所有(?:页面|组件|视图)|系统级/,
];

const BOUNDED_SCOPE_PATTERNS: RegExp[] = [
  // one explicitly named artifact
  /\b(?:a|an|one|single|just|only)\s+(?:single\s+)?(?:file|component|button|page|view|dialog|modal|style|css\s+rules?|class|function|method|typo|label|text|string)\b/i,
  /\b(?:in|to|inside)\s+(?:a|an|one)\s+(?:single\s+)?(?:file|component|page|view)\b/i,
  // one explicitly named file path
  /\b[\w[\]/.-]+\.(?:tsx|ts|jsx|js|css|scss|less|json|ya?ml|rs|py|go|rb|java|md|toml)\b/i,
  /(?:单个|一个|仅|只)\s*(?:文件|组件|按钮|页面|视图|弹窗|样式|类|函数|方法)/,
  /(?:只|仅)\s*(?:需|要|改|修改|调整|更新)/,
  // explicit smallness
  /\b(?:typo|cosmetic)\b/i,
  /\b(?:small|minor|tiny|trivial|quick)\s+(?:changes?|fix(?:es)?|tweaks?|updates?|adjustments?|edits?)\b/i,
  /小(?:改动|修改|调整|变更|问题)|简单(?:修改|调整|改动)/,
];

const CHANGE_VERB_PATTERNS: RegExp[] = [
  /\b(?:fix|implement|add|update|change|modify|refactor|create|remove|delete|replace|support|improve|optimi[sz]e|enable|disable|integrate|write|adjust|show|hide|render|merge)\b/i,
  /修复|修改|实现|添加|新增|增加|重构|创建|搭建|删除|移除|替换|支持|优化|改进|完善|集成|编写|调整|改成|改为|显示|隐藏|合并/,
];

const ANALYSIS_PATTERNS: RegExp[] = [
  /\b(?:analy[sz]e|analy[sz]is|investigate|audit|reviews?|understand|explain|diagnose|research|explore)\b/i,
  /分析|调研|研究|审查|审计|诊断|解读|理解|看看|排查/,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Recommend a Team chain for a launch request.
 *
 * Deterministic and local — never inspects the repository or calls a model.
 * The result is advisory: the selector labels it as a recommendation and the
 * user keeps the final choice.
 *
 * Rule order:
 * 1. high-risk signals -> `full_delivery`
 * 2. explicitly bounded local scope / small visual change -> `lightweight`
 * 3. otherwise -> `standard_delivery`
 *
 * Misleading-keyword note: a payment/security noun inside a request that is
 * explicitly a purely visual tweak ("修复支付页面的样式") does not force Full
 * Delivery — the visual qualifier downgrades it unless structural work is
 * also requested.
 */
export function recommendTeamChain(request: string): TeamChainRecommendation {
  const text = (request ?? "").trim();

  const analysisOnly =
    text.length > 0
    && matchesAny(text, ANALYSIS_PATTERNS)
    && !matchesAny(text, CHANGE_VERB_PATTERNS);

  if (!text) {
    return { chainId: "standard_delivery", reason: "standard_task", analysisOnly: false };
  }

  const highRisk = matchesAny(text, HIGH_RISK_PATTERNS);
  const visual = matchesAny(text, VISUAL_QUALIFIER_PATTERNS);
  const structural = matchesAny(text, STRUCTURAL_PATTERNS);
  const expansive = matchesAny(text, EXPANSIVE_PATTERNS);

  const visualDowngrade = highRisk && visual && !structural;

  if (highRisk && !visualDowngrade) {
    return { chainId: "full_delivery", reason: "high_risk", analysisOnly };
  }

  const bounded = !expansive && (visual || matchesAny(text, BOUNDED_SCOPE_PATTERNS));
  if (bounded) {
    return { chainId: "lightweight", reason: "bounded_scope", analysisOnly };
  }

  return {
    chainId: "standard_delivery",
    reason: analysisOnly ? "analysis_only" : "standard_task",
    analysisOnly,
  };
}
