import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TiptapInput } from "../tiptap-input";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      chatPanel: {
        fileHint: "file",
        agentHint: "agent",
        skillHint: "skill",
        noResults: "No results",
        cloneRepoFirst: "Clone a repository first",
        selectModel: "Select model",
        defaultModel: "Default model",
        filterModels: "Filter models",
        noModelsFound: "No models found",
        brave: "Brave",
        plan: "Plan",
        build: "Build",
        inputLabel: "Input",
        outputLabel: "Output",
        tokens: "tokens",
      },
      common: {
        send: "Send",
        stop: "Stop",
      },
      teamAttachments: {
        addFiles: "Attach text or image files",
        removeFile: "Remove attachment",
      },
    },
  }),
}));

vi.mock("../repo-picker", () => ({
  RepoPicker: () => <div data-testid="repo-picker" />,
}));

vi.mock("../acp-provider-dropdown", () => ({
  AcpProviderDropdown: () => <div data-testid="provider-dropdown" />,
}));

vi.mock("../utils/diagnostics", () => ({
  desktopAwareFetch: vi.fn(),
}));

vi.mock("../utils/theme", () => ({
  isDarkThemeActive: () => false,
}));

describe("TiptapInput paste handling", () => {
  it("inserts pasted images into the editor without triggering send", async () => {
    const onSend = vi.fn();

    class MockFileReader {
      public onload: ((event: { target: { result: string } }) => void) | null = null;

      readAsDataURL() {
        this.onload?.({ target: { result: "data:image/png;base64,ZmFrZQ==" } });
      }
    }

    vi.stubGlobal("FileReader", MockFileReader);

    render(
      <TiptapInput
        onSend={onSend}
        selectedProvider="claude"
        onRepoChange={vi.fn()}
        repoSelection={null}
      />,
    );

    const editor = screen.getByRole("textbox");
    const imageFile = new File(["fake"], "paste.png", { type: "image/png" });
    const getAsFile = vi.fn(() => imageFile);

    fireEvent.paste(editor, {
      clipboardData: {
        items: [{ type: "image/png", getAsFile }],
        files: [imageFile],
        types: ["Files"],
        getData: vi.fn(() => ""),
      },
    });

    await waitFor(() => {
      expect(document.querySelector("img[src=\"data:image/png;base64,ZmFrZQ==\"]")).toBeTruthy();
    });

    expect(getAsFile).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("TiptapInput attachment controls", () => {
  const baseProps = {
    onSend: vi.fn(),
    selectedProvider: "claude",
    onRepoChange: vi.fn(),
    repoSelection: null,
  };

  it("hides the attachment controls unless a composer opts in", () => {
    render(<TiptapInput {...baseProps} />);

    // Regular chat composers keep the pre-attachment layout.
    expect(screen.queryByTestId("tiptap-attachment-button")).toBeNull();
    expect(screen.queryByTestId("tiptap-attachment-file-input")).toBeNull();
  });

  it("shows the paperclip picker and forwards picked files", () => {
    const onAddAttachmentFiles = vi.fn();
    render(
      <TiptapInput
        {...baseProps}
        attachmentsEnabled
        onAddAttachmentFiles={onAddAttachmentFiles}
      />,
    );

    const pickerButton = screen.getByTestId("tiptap-attachment-button");
    expect(pickerButton.getAttribute("aria-label")).toBe("Attach text or image files");

    // The picker only offers accepted text/image extensions.
    const fileInput = screen.getByTestId("tiptap-attachment-file-input") as HTMLInputElement;
    expect(fileInput.accept).toContain(".txt");
    expect(fileInput.accept).toContain(".png");
    expect(fileInput.accept).not.toContain(".exe");

    const picked = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [picked] } });
    expect(onAddAttachmentFiles).toHaveBeenCalledWith([picked]);
  });

  it("forwards files dropped onto the editor wrapper", () => {
    const onAddAttachmentFiles = vi.fn();
    render(
      <TiptapInput
        {...baseProps}
        attachmentsEnabled
        onAddAttachmentFiles={onAddAttachmentFiles}
      />,
    );

    const dropped = new File(["dropped text"], "drop.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByTestId("tiptap-input"), {
      dataTransfer: { files: [dropped] },
    });
    expect(onAddAttachmentFiles).toHaveBeenCalledWith([dropped]);
  });

  it("does not forward dropped files while a send is in flight", () => {
    const onAddAttachmentFiles = vi.fn();
    render(
      <TiptapInput
        {...baseProps}
        attachmentsEnabled
        attachmentsDisabled
        onAddAttachmentFiles={onAddAttachmentFiles}
      />,
    );

    const dropped = new File(["dropped text"], "drop.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByTestId("tiptap-input"), {
      dataTransfer: { files: [dropped] },
    });
    expect(onAddAttachmentFiles).not.toHaveBeenCalled();
    // The picker button is frozen too.
    expect((screen.getByTestId("tiptap-attachment-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders draft chips with filename, kind, and a remove action", () => {
    const onRemoveAttachment = vi.fn();
    const drafts = [
      { id: "draft-1", file: new File(["hello"], "notes.txt", { type: "text/plain" }) },
      { id: "draft-2", file: new File(["x"], "shot.png", { type: "image/png" }) },
    ];
    render(
      <TiptapInput
        {...baseProps}
        attachmentsEnabled
        attachmentDrafts={drafts}
        attachmentErrors={["Attachment limit reached"]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    expect(screen.getByTestId("tiptap-attachment-panel").textContent).toContain("notes.txt");
    expect(screen.getByTestId("tiptap-attachment-panel").textContent).toContain("txt");
    expect(screen.getByTestId("tiptap-attachment-panel").textContent).toContain("shot.png");
    expect(screen.getByTestId("tiptap-attachment-panel").textContent).toContain("img");
    expect(screen.getByTestId("tiptap-attachment-panel").textContent).toContain("Attachment limit reached");

    const removeButtons = screen.getAllByRole("button", { name: "Remove attachment" });
    fireEvent.click(removeButtons[0]);
    expect(onRemoveAttachment).toHaveBeenCalledWith("draft-1");
  });

  it("builds the placeholder hint from the repository-file i18n hint", async () => {
    render(<TiptapInput {...baseProps} />);

    // `@` hints at repository file references (not local attachments); the
    // local paperclip is the attachment affordance. The Placeholder extension
    // renders the hint as a decoration on the empty paragraph node.
    await waitFor(() => {
      const placeholder = document.querySelector(".is-editor-empty")?.getAttribute("data-placeholder") ?? "";
      expect(placeholder).toContain("@ file");
      expect(placeholder).toContain("# agent");
      expect(placeholder).toContain("/ skill");
    });
  });
});
