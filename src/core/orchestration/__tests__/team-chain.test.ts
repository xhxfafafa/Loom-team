import { describe, expect, it } from "vitest";

import {
  buildTeamChainPolicyPrompt,
  DEFAULT_TEAM_CHAIN_ID,
  isTeamChainId,
  parseTeamChainId,
  recommendTeamChain,
  resolveEffectiveTeamChainId,
  TEAM_CHAIN_IDS,
  validateTeamChainAssignment,
} from "../team-chain";

describe("TEAM_CHAIN_IDS", () => {
  it("contains exactly the three MVP chains", () => {
    expect([...TEAM_CHAIN_IDS]).toEqual(["lightweight", "standard_delivery", "full_delivery"]);
  });

  it("defaults legacy runs to full_delivery", () => {
    expect(DEFAULT_TEAM_CHAIN_ID).toBe("full_delivery");
  });
});

describe("isTeamChainId / parseTeamChainId", () => {
  it("accepts the three known values", () => {
    expect(isTeamChainId("lightweight")).toBe(true);
    expect(isTeamChainId("standard_delivery")).toBe(true);
    expect(isTeamChainId("full_delivery")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isTeamChainId("investigation")).toBe(false);
    expect(isTeamChainId("full-delivery")).toBe(false);
    expect(isTeamChainId("FULL_DELIVERY")).toBe(false);
    expect(isTeamChainId("")).toBe(false);
    expect(isTeamChainId(42)).toBe(false);
    expect(isTeamChainId(null)).toBe(false);
    expect(isTeamChainId(undefined)).toBe(false);
  });

  it("parses raw values, keeping omitted/invalid values as null", () => {
    expect(parseTeamChainId("lightweight")).toBe("lightweight");
    expect(parseTeamChainId("investigation")).toBeNull();
    expect(parseTeamChainId(null)).toBeNull();
    expect(parseTeamChainId(undefined)).toBeNull();
  });
});

describe("resolveEffectiveTeamChainId", () => {
  it("interprets omitted/legacy values as full_delivery", () => {
    expect(resolveEffectiveTeamChainId(null)).toBe("full_delivery");
    expect(resolveEffectiveTeamChainId(undefined)).toBe("full_delivery");
  });

  it("keeps explicit values unchanged", () => {
    expect(resolveEffectiveTeamChainId("lightweight")).toBe("lightweight");
    expect(resolveEffectiveTeamChainId("standard_delivery")).toBe("standard_delivery");
    expect(resolveEffectiveTeamChainId("full_delivery")).toBe("full_delivery");
  });
});

describe("validateTeamChainAssignment", () => {
  const teamLeadRoot = { specialistId: "team-agent-lead", parentSessionId: null };

  it("accepts each known chain on a top-level team-agent-lead session", () => {
    for (const chainId of TEAM_CHAIN_IDS) {
      const result = validateTeamChainAssignment({ ...teamLeadRoot, teamChainId: chainId });
      expect(result).toEqual({ ok: true, teamChainId: chainId });
    }
  });

  it("accepts an omitted teamChainId and reports it as null (legacy)", () => {
    expect(validateTeamChainAssignment(teamLeadRoot)).toEqual({ ok: true, teamChainId: null });
    expect(validateTeamChainAssignment({ ...teamLeadRoot, teamChainId: undefined })).toEqual({
      ok: true,
      teamChainId: null,
    });
    expect(validateTeamChainAssignment({ ...teamLeadRoot, teamChainId: null })).toEqual({
      ok: true,
      teamChainId: null,
    });
  });

  it("rejects unknown chain values", () => {
    expect(validateTeamChainAssignment({ ...teamLeadRoot, teamChainId: "investigation" })).toEqual({
      ok: false,
      reason: "invalid_value",
    });
    expect(validateTeamChainAssignment({ ...teamLeadRoot, teamChainId: 12 })).toEqual({
      ok: false,
      reason: "invalid_value",
    });
  });

  it("rejects teamChainId on non-team-lead sessions", () => {
    expect(
      validateTeamChainAssignment({
        teamChainId: "lightweight",
        specialistId: "frontend-crafter",
        parentSessionId: null,
      }),
    ).toEqual({ ok: false, reason: "requires_team_lead" });
    expect(
      validateTeamChainAssignment({ teamChainId: "lightweight", specialistId: null, parentSessionId: null }),
    ).toEqual({ ok: false, reason: "requires_team_lead" });
  });

  it("rejects teamChainId on child sessions even for team-agent-lead", () => {
    expect(
      validateTeamChainAssignment({
        teamChainId: "lightweight",
        specialistId: "team-agent-lead",
        parentSessionId: "parent-1",
      }),
    ).toEqual({ ok: false, reason: "requires_root_session" });
  });
});

describe("buildTeamChainPolicyPrompt", () => {
  it("returns null for full_delivery and legacy/omitted values", () => {
    expect(buildTeamChainPolicyPrompt("full_delivery")).toBeNull();
    expect(buildTeamChainPolicyPrompt(null)).toBeNull();
    expect(buildTeamChainPolicyPrompt(undefined)).toBeNull();
  });

  it("resolves lightweight to a one-implementer self-verification policy", () => {
    const policy = buildTeamChainPolicyPrompt("lightweight");
    expect(policy).not.toBeNull();
    expect(policy).toContain("Team Chain Policy: Lightweight");
    expect(policy).toContain("at most ONE child agent");
    expect(policy).toContain("verifies their own work");
    expect(policy).toContain("do NOT spawn an independent QA or code-review agent");
    expect(policy).toContain("Stop and escalate");
    expect(policy).toContain("Completion output");
  });

  it("resolves standard_delivery to an implementation plus one independent verifier policy", () => {
    const policy = buildTeamChainPolicyPrompt("standard_delivery");
    expect(policy).not.toBeNull();
    expect(policy).toContain("Team Chain Policy: Standard Delivery");
    expect(policy).toContain("one primary implementation specialist");
    expect(policy).toContain("exactly ONE independent verification stage");
    expect(policy).toContain("behavior or UI changes -> qa");
    expect(policy).toContain("code-structure or interface changes -> code-reviewer");
    expect(policy).toContain("when both apply -> qa");
    expect(policy).toContain("Stop and escalate");
    expect(policy).toContain("Completion output");
  });

  it("keeps non-full policies free of absolute full-delivery verification mandates", () => {
    for (const chainId of ["lightweight", "standard_delivery"] as const) {
      const policy = buildTeamChainPolicyPrompt(chainId);
      expect(policy).not.toContain("No exceptions");
      expect(policy).not.toContain("Every implementation gets checked");
    }
  });
});

describe("recommendTeamChain", () => {
  it("routes high-risk signals to full_delivery", () => {
    expect(recommendTeamChain("Add a database migration for the new orders table")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
    expect(recommendTeamChain("Implement role-based permissions for workspace admins")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
    expect(recommendTeamChain("Fix the security vulnerability in token validation")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
    expect(recommendTeamChain("重构支付流程并接入新的 billing provider")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
    expect(recommendTeamChain("Keep Web and Desktop behavior in sync for this feature")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
  });

  it("routes explicitly bounded local scope to lightweight", () => {
    expect(recommendTeamChain("Fix a typo in the README")).toMatchObject({
      chainId: "lightweight",
      reason: "bounded_scope",
    });
    expect(recommendTeamChain("Update the submit button label in settings-page.tsx")).toMatchObject({
      chainId: "lightweight",
      reason: "bounded_scope",
    });
    expect(recommendTeamChain("只修改一个组件的提示文案")).toMatchObject({
      chainId: "lightweight",
      reason: "bounded_scope",
    });
  });

  it("routes small visual changes to lightweight", () => {
    expect(recommendTeamChain("Adjust the spacing and color of the sidebar")).toMatchObject({
      chainId: "lightweight",
      reason: "bounded_scope",
    });
  });

  it("routes ordinary development tasks to standard_delivery", () => {
    expect(recommendTeamChain("Add pagination to the session list endpoint")).toMatchObject({
      chainId: "standard_delivery",
      reason: "standard_task",
    });
    expect(recommendTeamChain("给团队页面增加运行状态筛选功能")).toMatchObject({
      chainId: "standard_delivery",
      reason: "standard_task",
    });
    expect(recommendTeamChain("")).toMatchObject({
      chainId: "standard_delivery",
      reason: "standard_task",
    });
  });

  it("handles misleading payment keywords in purely visual requests", () => {
    // "支付" is a high-risk keyword, but the requested change is a bounded
    // visual tweak — it must not be forced into Full Delivery.
    expect(recommendTeamChain("修复支付页面的样式")).toMatchObject({
      chainId: "lightweight",
      reason: "bounded_scope",
    });
    // Once structural work is requested, the payment keyword wins again.
    expect(recommendTeamChain("修复支付页面的样式并重构支付逻辑")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
    expect(recommendTeamChain("修改支付逻辑")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
  });

  it("handles mixed intent without disguising analysis as a safe chain", () => {
    // "analyze and fix" is a change request, not analysis-only.
    expect(recommendTeamChain("Analyze and fix the flaky session list test")).toMatchObject({
      chainId: "standard_delivery",
      analysisOnly: false,
    });
    // Pure analysis stays flagged so the UI can explain the MVP limitation.
    expect(recommendTeamChain("Analyze why the build is slow")).toMatchObject({
      chainId: "standard_delivery",
      reason: "analysis_only",
      analysisOnly: true,
    });
    expect(recommendTeamChain("分析一下这个模块的性能瓶颈")).toMatchObject({
      chainId: "standard_delivery",
      reason: "analysis_only",
      analysisOnly: true,
    });
  });

  it("handles mixed-language requests", () => {
    expect(recommendTeamChain("Refactor the auth middleware 并更新 permissions UI")).toMatchObject({
      chainId: "full_delivery",
      reason: "high_risk",
    });
    expect(recommendTeamChain("Fix the CSS alignment issue in the team page header")).toMatchObject({
      chainId: "lightweight",
      reason: "bounded_scope",
    });
  });

  it("does not recommend lightweight for expansive visual rework", () => {
    expect(recommendTeamChain("Redesign the entire dashboard visual style")).toMatchObject({
      chainId: "standard_delivery",
      reason: "standard_task",
    });
  });
});
