import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/client/components/chat-panel/types";
import { SessionTimelineSection } from "../team-run-page-sections";
import type { SessionLaneItem } from "../team-run-page-model";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      team: {
        sessionTimeline: "Session timeline",
        messages: "messages",
        membersCount: "members",
        noLeadTimelineYet: "No timeline",
        noTranscriptYet: "No transcript yet",
        updates: "updates",
        openViewer: "Open viewer",
        expandThread: "Expand thread",
        showLessThread: "Show less",
        openThisThread: "Open this thread",
        awaitingInput: "Awaiting input",
      },
      teamRuntime: {
        statusIdle: "Idle",
        statusWorking: "Working",
        statusBlocked: "Blocked",
        statusReviewing: "Reviewing",
        statusDone: "Done",
        statusSuspended: "Suspended",
        statusRecovering: "Recovering",
        statusFailed: "Failed",
      },
    },
  }),
}));

vi.mock("@/client/components/message-bubble", () => ({
  MessageBubble: ({ message }: { message: ChatMessage }) => <div>{message.content}</div>,
  AskUserQuestionBubble: () => null,
}));

/** Bottom-follow must treat "within 48px of the bottom" as pinned. */
const BOTTOM_FOLLOW_THRESHOLD_PX = 48;

type ResizeCallback = ResizeObserverCallback;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];

  callback: ResizeCallback;
  observedElements: Element[] = [];
  disconnectCalls = 0;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observedElements.push(element);
  }

  unobserve(element: Element) {
    this.observedElements = this.observedElements.filter((entry) => entry !== element);
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.observedElements = [];
  }

  /** Simulate the browser reporting a rendered-size change. */
  trigger() {
    this.callback([], this);
  }
}

let nextFrameId = 1;
let pendingFrames = new Map<number, FrameRequestCallback>();

const installFrameMocks = () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    pendingFrames.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    pendingFrames.delete(frameId);
  });
};

/** Run every pending animation frame (one coalesced scroll pass each). */
const flushFrames = () => {
  const due = [...pendingFrames.values()];
  pendingFrames.clear();
  for (const callback of due) {
    callback(0);
  }
};

const setTimelineGeometry = (
  timeline: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number },
) => {
  Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: geometry.scrollHeight });
  Object.defineProperty(timeline, "clientHeight", { configurable: true, value: geometry.clientHeight });
};

const makeLeadMessages = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `lead-message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Lead message ${index}`,
    timestamp: new Date(),
  }));

const makeLane = (messages: ChatMessage[]): SessionLaneItem => ({
  id: "lane-child-1",
  sessionId: "child-session-1",
  actor: "Crafter",
  roleId: "crafter",
  roleLabel: "Crafter",
  badge: "member",
  sessionName: "Child session",
  status: "working",
  lastUpdatedLabel: "just now",
  eventCount: messages.length,
  snippets: [],
  messages,
  pendingQuestion: null,
});

const renderTimeline = (overrides?: {
  leadMessages?: ChatMessage[];
  memberLaneByToolCallId?: Map<string, SessionLaneItem>;
}) => {
  const leadMessages = overrides?.leadMessages ?? makeLeadMessages(2);
  return render(
    <SessionTimelineSection
      leadMessages={leadMessages}
      memberLaneByToolCallId={overrides?.memberLaneByToolCallId ?? new Map()}
      sessionLanes={[]}
      onSelectSession={vi.fn()}
      onOpenViewer={vi.fn()}
      sessionBlockRef={vi.fn()}
    />,
  );
};

describe("SessionTimelineSection", () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    nextFrameId = 1;
    pendingFrames = new Map();
    installFrameMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it("scrolls to the newest lead message after the restored timeline lays out", () => {
    renderTimeline({ leadMessages: makeLeadMessages(1) });

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 1200, clientHeight: 400 });
    flushFrames();

    expect(timeline.scrollTop).toBe(1200);
  });

  it("observes the timeline content wrapper with a ResizeObserver", () => {
    renderTimeline();

    const content = screen.getByTestId("team-timeline-content");
    const observer = MockResizeObserver.instances.at(-1);
    expect(observer).toBeTruthy();
    expect(observer?.observedElements).toContain(content);
  });

  it("keeps following the bottom when only a child lane grows and Lead messages stay unchanged", () => {
    const leadMessageWithLane: ChatMessage = {
      id: "lead-delegate",
      role: "tool",
      content: "delegate_task",
      timestamp: new Date(),
      toolName: "delegate_task",
      toolCallId: "tool-call-1",
    };
    const lane = makeLane([
      { id: "child-1", role: "assistant", content: "child working", timestamp: new Date() },
    ]);

    const { rerender } = render(
      <SessionTimelineSection
        leadMessages={[leadMessageWithLane]}
        memberLaneByToolCallId={new Map([["tool-call-1", lane]])}
        sessionLanes={[]}
        onSelectSession={vi.fn()}
        onOpenViewer={vi.fn()}
        sessionBlockRef={vi.fn()}
      />,
    );

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 1000, clientHeight: 400 });
    flushFrames();
    // Initial hydration leaves the timeline pinned to the bottom.
    expect(timeline.scrollTop).toBe(1000);

    // The child lane receives a new message while the latest Lead message is
    // unchanged; the rendered height grows.
    rerender(
      <SessionTimelineSection
        leadMessages={[leadMessageWithLane]}
        memberLaneByToolCallId={new Map([["tool-call-1", {
          ...lane,
          messages: [
            ...lane.messages,
            { id: "child-2", role: "assistant", content: "child finished", timestamp: new Date() },
          ],
        }]])}
        sessionLanes={[]}
        onSelectSession={vi.fn()}
        onOpenViewer={vi.fn()}
        sessionBlockRef={vi.fn()}
      />,
    );
    setTimelineGeometry(timeline, { scrollHeight: 1300, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();

    expect(timeline.scrollTop).toBe(1300);
  });

  it("follows asynchronous rendered-height changes while pinned", () => {
    renderTimeline();

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 800, clientHeight: 400 });
    flushFrames();
    expect(timeline.scrollTop).toBe(800);

    // First async growth (e.g. Markdown still rendering).
    setTimelineGeometry(timeline, { scrollHeight: 950, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();
    expect(timeline.scrollTop).toBe(950);

    // A later independent growth must trigger the same follow behavior.
    setTimelineGeometry(timeline, { scrollHeight: 1100, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();
    expect(timeline.scrollTop).toBe(1100);
  });

  it("coalesces multiple resize notifications into a single animation frame", () => {
    renderTimeline();

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 800, clientHeight: 400 });
    flushFrames();

    const observer = MockResizeObserver.instances.at(-1);
    observer?.trigger();
    observer?.trigger();
    observer?.trigger();
    // Three resize notifications share ONE pending frame.
    expect(pendingFrames.size).toBe(1);

    setTimelineGeometry(timeline, { scrollHeight: 1000, clientHeight: 400 });
    flushFrames();
    expect(timeline.scrollTop).toBe(1000);
  });

  it("does not pull the user back after they scrolled more than the threshold above the bottom", () => {
    renderTimeline();

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 1000, clientHeight: 400 });
    flushFrames();
    expect(timeline.scrollTop).toBe(1000);

    // The user scrolls up: distance to bottom is now far beyond the threshold.
    const unpinnedScrollTop = 1000 - 400 - BOTTOM_FOLLOW_THRESHOLD_PX - 120;
    timeline.scrollTop = unpinnedScrollTop;
    fireEvent.scroll(timeline);

    // New content grows the timeline; the reading position must be preserved.
    setTimelineGeometry(timeline, { scrollHeight: 1400, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();

    expect(timeline.scrollTop).toBe(unpinnedScrollTop);
  });

  it("resumes following once the user scrolls back within the threshold of the bottom", () => {
    renderTimeline();

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 1000, clientHeight: 400 });
    flushFrames();

    // Scroll away (unpinned), then back near the bottom (pinned again).
    timeline.scrollTop = 100;
    fireEvent.scroll(timeline);
    setTimelineGeometry(timeline, { scrollHeight: 1400, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();
    expect(timeline.scrollTop).toBe(100);

    timeline.scrollTop = 1400 - 400 - 24; // 24px from the bottom: within threshold.
    fireEvent.scroll(timeline);

    setTimelineGeometry(timeline, { scrollHeight: 1700, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();

    expect(timeline.scrollTop).toBe(1700);
  });

  it("follows growth caused by expanding a child thread while pinned", () => {
    const leadMessageWithLane: ChatMessage = {
      id: "lead-delegate",
      role: "tool",
      content: "delegate_task",
      timestamp: new Date(),
      toolName: "delegate_task",
      toolCallId: "tool-call-1",
    };
    const lane = makeLane([
      { id: "child-1", role: "assistant", content: "first child message", timestamp: new Date() },
      { id: "child-2", role: "assistant", content: "second child message", timestamp: new Date() },
    ]);

    render(
      <SessionTimelineSection
        leadMessages={[leadMessageWithLane]}
        memberLaneByToolCallId={new Map([["tool-call-1", lane]])}
        sessionLanes={[]}
        onSelectSession={vi.fn()}
        onOpenViewer={vi.fn()}
        sessionBlockRef={vi.fn()}
      />,
    );

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    setTimelineGeometry(timeline, { scrollHeight: 900, clientHeight: 400 });
    flushFrames();
    expect(timeline.scrollTop).toBe(900);

    // Expanding the thread renders the full lane transcript, growing content.
    fireEvent.click(screen.getByRole("button", { name: "Expand thread" }));
    setTimelineGeometry(timeline, { scrollHeight: 1500, clientHeight: 400 });
    MockResizeObserver.instances.at(-1)?.trigger();
    flushFrames();

    expect(timeline.scrollTop).toBe(1500);
  });

  it("disconnects the observer, removes listeners, and cancels the pending frame on unmount", () => {
    const { unmount } = renderTimeline();

    const timeline = screen.getByTestId("team-timeline-scroll-region");
    const removeListenerSpy = vi.spyOn(timeline, "removeEventListener");
    const observer = MockResizeObserver.instances.at(-1);
    expect(observer).toBeTruthy();

    // Leave a follow frame pending, then unmount before it runs.
    observer?.trigger();
    expect(pendingFrames.size).toBeGreaterThanOrEqual(1);

    unmount();

    expect(observer?.disconnectCalls).toBe(1);
    expect(pendingFrames.size).toBe(0);
    expect(removeListenerSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
