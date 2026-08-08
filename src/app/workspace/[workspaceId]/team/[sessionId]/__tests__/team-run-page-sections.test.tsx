import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/client/components/chat-panel/types";
import { SessionTimelineSection } from "../team-run-page-sections";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      team: {
        sessionTimeline: "Session timeline",
        messages: "messages",
        membersCount: "members",
        noLeadTimelineYet: "No timeline",
      },
    },
  }),
}));

vi.mock("@/client/components/message-bubble", () => ({
  MessageBubble: ({ message }: { message: ChatMessage }) => <div>{message.content}</div>,
  AskUserQuestionBubble: () => null,
}));

describe("SessionTimelineSection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrolls to the newest lead message after the restored timeline lays out", () => {
    let queuedFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    render(
      <SessionTimelineSection
        leadMessages={[{
          id: "latest-message",
          role: "assistant",
          content: "Most recent team update",
          timestamp: new Date(),
        }]}
        memberLaneByToolCallId={new Map()}
        sessionLanes={[]}
        onSelectSession={vi.fn()}
        onOpenViewer={vi.fn()}
        sessionBlockRef={vi.fn()}
      />,
    );

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1200 });
    queuedFrame?.(0);

    expect(timeline.scrollTop).toBe(1200);
  });
});
