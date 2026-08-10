import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamChainSelector } from "../team-chain-selector";
import type { TeamChainRecommendation } from "@/core/orchestration/team-chain";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      teamChain: {
        label: "Execution Chain",
        recommended: "Recommended",
        lightweight: "Lightweight",
        standardDelivery: "Standard Delivery",
        fullDelivery: "Full Delivery",
        lightweightPurpose: "One bounded change, delivered fast.",
        standardDeliveryPurpose: "One primary change with independent verification.",
        fullDeliveryPurpose: "Full multi-stage delivery with research and review.",
        lightweightPattern: "Lead -> one implementer -> delivery",
        standardDeliveryPattern: "Lead -> one implementer -> one independent verifier",
        fullDeliveryPattern: "Lead -> research, implementation, QA and review waves",
        lightweightVerification: "Self-verification by the implementer",
        standardDeliveryVerification: "One independent QA or code review",
        fullDeliveryVerification: "Independent QA and code review",
        reasonHighRisk: "High-risk change detected",
        reasonBoundedScope: "Small, bounded scope",
        reasonStandardTask: "Standard development task",
        reasonAnalysisOnly: "Analysis-only request",
        analysisOnlyNote: "The MVP has no enforced read-only Team chain. This run may still modify code.",
      },
    },
  }),
}));

const standardRecommendation: TeamChainRecommendation = {
  chainId: "standard_delivery",
  reason: "standard_task",
  analysisOnly: false,
};

describe("TeamChainSelector", () => {
  it("shows three localized chain choices with purpose, pattern and verification", () => {
    render(
      <TeamChainSelector
        recommendation={standardRecommendation}
        selectedChainId="standard_delivery"
        onSelect={vi.fn()}
      />,
    );

    // Trigger shows the effective selection and the advisory badge.
    expect(screen.getByTestId("team-chain-selector-value").textContent).toBe("Standard Delivery");
    expect(screen.getByText("Recommended")).toBeTruthy();

    fireEvent.click(screen.getByTestId("team-chain-selector"));

    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByTestId("team-chain-option-lightweight")).toBeTruthy();
    expect(screen.getByTestId("team-chain-option-standard_delivery")).toBeTruthy();
    expect(screen.getByTestId("team-chain-option-full_delivery")).toBeTruthy();

    // Each option carries name, purpose, agent pattern and verification strength.
    expect(screen.getByText("Lightweight")).toBeTruthy();
    expect(screen.getByText("Full Delivery")).toBeTruthy();
    expect(screen.getByText("One bounded change, delivered fast.")).toBeTruthy();
    expect(screen.getByText("One primary change with independent verification.")).toBeTruthy();
    expect(screen.getByText("Full multi-stage delivery with research and review.")).toBeTruthy();
    expect(screen.getByText("Lead -> one implementer -> delivery")).toBeTruthy();
    expect(screen.getByText("Lead -> one implementer -> one independent verifier")).toBeTruthy();
    expect(screen.getByText("Lead -> research, implementation, QA and review waves")).toBeTruthy();
    expect(screen.getByText("Self-verification by the implementer")).toBeTruthy();
    expect(screen.getByText("One independent QA or code review")).toBeTruthy();
    expect(screen.getByText("Independent QA and code review")).toBeTruthy();

    // The recommendation is labeled advisory on the matching option.
    const recommendedOption = screen.getByTestId("team-chain-option-standard_delivery");
    expect(recommendedOption.textContent).toContain("Recommended");
    expect(recommendedOption.getAttribute("aria-selected")).toBe("true");
  });

  it("user selection overrides the recommendation and closes the popover", () => {
    const onSelect = vi.fn();
    render(
      <TeamChainSelector
        recommendation={standardRecommendation}
        selectedChainId="standard_delivery"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId("team-chain-selector"));
    fireEvent.click(screen.getByTestId("team-chain-option-lightweight"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("lightweight");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("surfaces the analysis-only caveat and localized reason", () => {
    render(
      <TeamChainSelector
        recommendation={{ chainId: "standard_delivery", reason: "analysis_only", analysisOnly: true }}
        selectedChainId="standard_delivery"
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("team-chain-selector"));

    expect(screen.getByText("Analysis-only request")).toBeTruthy();
    expect(screen.getByTestId("team-chain-analysis-note").textContent).toBe(
      "The MVP has no enforced read-only Team chain. This run may still modify code.",
    );
  });

  it("hides the recommended badge when the user picked a different chain", () => {
    render(
      <TeamChainSelector
        recommendation={standardRecommendation}
        selectedChainId="lightweight"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("team-chain-selector-value").textContent).toBe("Lightweight");
    expect(screen.queryByText("Recommended")).toBeNull();
  });
});
