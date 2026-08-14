import { describe, expect, it, vi } from "vitest";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import WorkspacePage from "../page";

describe("workspace root page", () => {
  it("redirects the workspace root to the kanban surface", async () => {
    await WorkspacePage({
      params: Promise.resolve({ workspaceId: "default" }),
    });

    expect(redirectMock).toHaveBeenCalledWith("/workspace/default/kanban");
  });
});
