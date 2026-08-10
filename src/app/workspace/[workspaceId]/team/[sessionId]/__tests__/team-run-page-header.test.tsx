import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamRunPageHeader } from "../team-run-page-header";
import type { SessionInfo } from "../../../types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      team: {
        teamRuns: "Team Runs",
      },
      teamChain: {
        label: "Execution Chain",
        lightweight: "Lightweight",
        standardDelivery: "Standard Delivery",
        fullDelivery: "Full Delivery",
      },
    },
  }),
}));

function renderHeader(teamRuns: SessionInfo[]) {
  return render(
    <TeamRunPageHeader
      workspaceId="ws-1"
      selectedSessionId={teamRuns[0].sessionId}
      selectedSessionName={teamRuns[0].name ?? teamRuns[0].sessionId}
      teamRuns={teamRuns}
      isSwitchingTeamRun={false}
      backLabel="Back"
      refreshLabel="Refresh"
      openLabel="Open"
      activeLabel="ACTIVE"
      waitingLabel="WAITING"
      deleteLabel="Delete"
      onRefresh={vi.fn()}
      onSwitchTeamRun={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("TeamRunPageHeader chain label", () => {
  it("restores the persisted execution chain as a read-only label", () => {
    renderHeader([
      {
        sessionId: "run-standard",
        name: "Team - Ship feature",
        workspaceId: "ws-1",
        cwd: "/tmp/project",
        specialistId: "team-agent-lead",
        teamChainId: "standard_delivery",
        createdAt: "2026-04-03T10:00:00.000Z",
      },
    ]);

    const label = screen.getByTestId("team-run-chain-label");
    expect(label.textContent).toBe("Standard Delivery");
    expect(label.getAttribute("title")).toBe("Execution Chain");
  });

  it("shows lightweight for runs persisted with the lightweight chain", () => {
    renderHeader([
      {
        sessionId: "run-lightweight",
        name: "Team - Tiny fix",
        workspaceId: "ws-1",
        cwd: "/tmp/project",
        specialistId: "team-agent-lead",
        teamChainId: "lightweight",
        createdAt: "2026-04-03T10:00:00.000Z",
      },
    ]);

    expect(screen.getByTestId("team-run-chain-label").textContent).toBe("Lightweight");
  });

  it("interprets legacy runs without teamChainId as Full Delivery", () => {
    renderHeader([
      {
        sessionId: "run-legacy",
        name: "Team - Old run",
        workspaceId: "ws-1",
        cwd: "/tmp/project",
        specialistId: "team-agent-lead",
        createdAt: "2026-04-03T10:00:00.000Z",
      },
    ]);

    expect(screen.getByTestId("team-run-chain-label").textContent).toBe("Full Delivery");
  });
});
