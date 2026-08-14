import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../spec-page-client", () => ({
  SpecPageClient: () => <div data-testid="spec-page-client">spec client</div>,
}));

import WorkspaceSpecPage from "../page";

describe("workspace spec page", () => {
  it("renders the client shell", () => {
    render(<WorkspaceSpecPage />);

    expect(screen.getByTestId("spec-page-client").textContent).toContain("spec client");
  });
});
