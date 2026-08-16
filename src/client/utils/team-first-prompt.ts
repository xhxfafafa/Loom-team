/**
 * Team prompt construction shared by the initial Team Run launch and
 * follow-up timeline prompts.
 *
 * Builds the ACP content blocks sent to the Team Lead: the user's request,
 * the `@`-selected repository file paths, text attachments as embedded
 * resources, and images as image blocks. All attachment bytes must already
 * be normalized by the strict Kanban attachment validator before reaching
 * this builder.
 */

import type { FileReference } from "@/client/components/tiptap-input";
import type { RepositoryFileReference } from "./attachment-draft";
import type { AcpContentBlock } from "@/core/acp/protocol-types";
import type { NormalizedTaskAttachment } from "@/core/kanban/task-attachments";

export const TEAM_INPUT_RESOURCE_SCHEME = "routa-team-input://";

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Keep only repository references that live inside the selected repository
 * and convert them to repository-relative paths. References outside the
 * repository are rejected instead of embedded, and `..` segments are never
 * accepted.
 */
export function resolveRepositoryFileReferences(
  files: FileReference[] | undefined,
  repoPath: string | undefined,
): RepositoryFileReference[] {
  if (!files || files.length === 0) return [];
  const normalizedRepo = normalizeSeparators(repoPath ?? "").replace(/\/+$/, "");
  if (!normalizedRepo) return [];

  const accepted: RepositoryFileReference[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const candidate = normalizeSeparators(file.path ?? "").replace(/\/+$/, "");
    if (!candidate || candidate.split("/").includes("..")) continue;
    if (!candidate.startsWith(`${normalizedRepo}/`)) continue;
    const relativePath = candidate.slice(normalizedRepo.length + 1);
    if (!relativePath || relativePath.split("/").includes("..")) continue;
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    accepted.push({ path: relativePath, label: file.label || relativePath });
  }
  return accepted;
}

/** Compact prompt section listing repository-relative paths only. */
export function formatRepositoryFilesSection(
  repositoryFiles: RepositoryFileReference[],
): string | undefined {
  if (repositoryFiles.length === 0) return undefined;
  const lines = repositoryFiles.map((file) => `- ${file.path}`);
  return ["Repository files:", ...lines].join("\n");
}

export interface TeamPromptContentInput {
  text: string;
  repositoryFiles?: RepositoryFileReference[];
  attachments?: NormalizedTaskAttachment[];
  /**
   * Scope used in synthetic attachment resource URIs. Initial launches
   * supply their IndexedDB transfer ID; follow-up prompts supply their
   * stable promptId so a retry rebuilds identical URIs.
   */
  resourceScopeId: string;
}

/**
 * Build Team prompt blocks in the documented order: request text,
 * repository file paths, text attachments as embedded resources with a
 * synthetic URI, then images. Attachment content is only referenced — never
 * copied into the visible text blocks.
 */
export function buildTeamPromptContentBlocks(input: TeamPromptContentInput): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [{ type: "text", text: input.text }];

  const repositorySection = formatRepositoryFilesSection(input.repositoryFiles ?? []);
  if (repositorySection) {
    blocks.push({ type: "text", text: repositorySection });
  }

  const resourceScopeId = input.resourceScopeId || "unknown";
  let textAttachmentIndex = 0;
  for (const attachment of input.attachments ?? []) {
    if (attachment.encoding === "utf8") {
      blocks.push({
        type: "resource",
        resource: {
          type: "resource",
          uri: `${TEAM_INPUT_RESOURCE_SCHEME}${resourceScopeId}/${textAttachmentIndex}`,
          mimeType: attachment.mediaType,
          text: attachment.content,
        },
      });
      textAttachmentIndex += 1;
    } else {
      blocks.push({
        type: "image",
        data: attachment.content,
        mimeType: attachment.mediaType,
      });
    }
  }

  return blocks;
}
