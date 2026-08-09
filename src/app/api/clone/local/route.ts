import { NextRequest, NextResponse } from "next/server";
import * as path from "path";

import {
  getBranchInfo,
  getRepoStatus,
  isGitHubUrl,
  normalizeLocalRepoPath,
  validateRepoInput,
  type RepoStatus,
} from "@/core/git";

const EMPTY_REPO_STATUS: RepoStatus = {
  clean: true,
  ahead: 0,
  behind: 0,
  modified: 0,
  untracked: 0,
};

/**
 * POST /api/clone/local
 *
 * Loads any existing, readable local folder as a project. Being a git
 * repository is optional: git metadata (branch/status) is only collected
 * when the folder actually is a git working repository.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rawPath = typeof body?.path === "string" ? body.path : "";

    if (!rawPath.trim()) {
      return NextResponse.json({ error: "Missing 'path' field" }, { status: 400 });
    }

    if (isGitHubUrl(rawPath.trim())) {
      return NextResponse.json(
        { error: "Use the GitHub clone flow for GitHub URLs" },
        { status: 400 },
      );
    }

    const repoPath = normalizeLocalRepoPath(rawPath);
    const validation = validateRepoInput(repoPath);
    if (!validation.valid || validation.isGitHub) {
      return NextResponse.json(
        {
          error: validation.error ?? "Invalid local folder path",
          errorCode: validation.errorCode,
        },
        { status: 400 },
      );
    }

    if (validation.isBareGit) {
      return NextResponse.json(
        {
          error: "Cannot add a bare git repository as a codebase",
          errorCode: "bare_repository",
        },
        { status: 400 },
      );
    }

    const name = path.basename(repoPath);

    if (!validation.isGit) {
      // Plain local folder: no git commands are executed.
      return NextResponse.json({
        success: true,
        name,
        path: repoPath,
        git: false,
        branch: "",
        branches: [],
        status: EMPTY_REPO_STATUS,
      });
    }

    const branchInfo = getBranchInfo(repoPath);

    return NextResponse.json({
      success: true,
      name,
      path: repoPath,
      git: true,
      branch: branchInfo.current,
      branches: branchInfo.branches,
      status: getRepoStatus(repoPath),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load local folder" },
      { status: 500 },
    );
  }
}
