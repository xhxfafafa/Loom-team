import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepoPicker } from "../repo-picker";

const { desktopAwareFetch } = vi.hoisted(() => ({
  desktopAwareFetch: vi.fn(),
}));

vi.mock("../../utils/diagnostics", () => ({
  desktopAwareFetch,
}));

vi.mock("../branch-selector", () => ({
  BranchSelector: ({ currentBranch }: { currentBranch?: string }) => (
    <div data-testid="branch-selector">{currentBranch ?? ""}</div>
  ),
}));

describe("RepoPicker", () => {
  beforeEach(() => {
    desktopAwareFetch.mockReset();
    desktopAwareFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/clone" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ repos: [] }), { status: 200 });
      }

      if (url === "/api/clone/local" && init?.method === "POST") {
        const payload = init.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify({
            success: true,
            name: "routa-js",
            path: payload.path,
            branch: "main",
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });

    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("loads a local repository from the local project tab", async () => {
    const onChange = vi.fn();

    render(<RepoPicker value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /select, clone, or load a repository/i }));
    fireEvent.click(screen.getByRole("button", { name: /local project/i }));
    fireEvent.change(screen.getByPlaceholderText("/Users/you/project or ~/project"), {
      target: { value: "~/code/routa-js" },
    });
    fireEvent.click(screen.getByRole("button", { name: /use local project/i }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        name: "routa-js",
        path: "~/code/routa-js",
        branch: "main",
      }),
    );
  });

  it("switches from search to local mode when the query looks like a file path", async () => {
    render(<RepoPicker value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /select, clone, or load a repository/i }));
    fireEvent.change(
      screen.getByPlaceholderText("Search repositories, paste GitHub URL, or enter local path..."),
      {
        target: { value: "~/code/routa-js" },
      },
    );

    await waitFor(() => {
      expect(screen.getByText("Local Folder Path")).toBeTruthy();
      expect(
        screen.getByDisplayValue("~/code/routa-js"),
      ).toBeTruthy();
    });
  });

  it("marks plain local folders as non-git selections", async () => {
    desktopAwareFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/clone" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ repos: [] }), { status: 200 });
      }

      if (url === "/api/clone/local" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            success: true,
            name: "plain-folder",
            path: "/tmp/plain-folder",
            git: false,
            branch: "",
            branches: [],
            status: { clean: true, ahead: 0, behind: 0, modified: 0, untracked: 0 },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });

    const onChange = vi.fn();
    render(<RepoPicker value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /select, clone, or load a repository/i }));
    fireEvent.click(screen.getByRole("button", { name: /local project/i }));
    fireEvent.change(screen.getByPlaceholderText("/Users/you/project or ~/project"), {
      target: { value: "/tmp/plain-folder" },
    });
    fireEvent.click(screen.getByRole("button", { name: /use local project/i }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        name: "plain-folder",
        path: "/tmp/plain-folder",
        branch: "",
        git: false,
      }),
    );
  });

  it("shows a localized error when the local folder does not exist", async () => {
    desktopAwareFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/clone" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ repos: [] }), { status: 200 });
      }

      if (url === "/api/clone/local" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: "Local folder does not exist: /tmp/missing",
            errorCode: "not_found",
          }),
          { status: 400 },
        );
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });

    render(<RepoPicker value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /select, clone, or load a repository/i }));
    fireEvent.click(screen.getByRole("button", { name: /local project/i }));
    fireEvent.change(screen.getByPlaceholderText("/Users/you/project or ~/project"), {
      target: { value: "/tmp/missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /use local project/i }));

    await waitFor(() =>
      expect(
        screen.getByText("The folder does not exist. Check the path and try again."),
      ).toBeTruthy(),
    );
  });

  it("shows the non-git notice instead of branch controls for plain folders", () => {
    render(
      <RepoPicker
        value={{ name: "plain-folder", path: "/tmp/plain-folder", branch: "", git: false }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("No version control")).toBeTruthy();
    expect(screen.queryByTestId("branch-selector")).toBeNull();
  });

  it("keeps branch controls for git repositories", () => {
    render(
      <RepoPicker
        value={{ name: "routa-js", path: "/tmp/routa-js", branch: "main", git: true }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("No version control")).toBeNull();
    expect(screen.getByTestId("branch-selector")).toBeTruthy();
  });

  it("shows full worktree path on hover and offers copy for muted path display", async () => {
    render(
      <RepoPicker
        value={{
          name: "issue-cf7f1e28-feat-kanban-very-long-worktree-name",
          path: "/Users/phodal/.routa/workspace/default/default/fcfe6cca-4de0-43da-b869-8641df9625e4/issue-cf7f1e28-feat-kanban-very-long-worktree-name",
          branch: "main",
        }}
        onChange={vi.fn()}
        pathDisplay="below-muted"
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /issue-cf7f1e28-feat.*name/i,
    });
    expect(trigger.textContent).toContain("...");
    expect(trigger.getAttribute("title")).toBe(
      "issue-cf7f1e28-feat-kanban-very-long-worktree-name\n/Users/phodal/.routa/workspace/default/default/fcfe6cca-4de0-43da-b869-8641df9625e4/issue-cf7f1e28-feat-kanban-very-long-worktree-name",
    );

    expect(screen.getByText(/^~\/\.\.\.\/fcfe6cca.*\/issue-cf7f1e28.*name$/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy to clipboard/i }));
    });
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/Users/phodal/.routa/workspace/default/default/fcfe6cca-4de0-43da-b869-8641df9625e4/issue-cf7f1e28-feat-kanban-very-long-worktree-name",
      );
    });
  });
});
