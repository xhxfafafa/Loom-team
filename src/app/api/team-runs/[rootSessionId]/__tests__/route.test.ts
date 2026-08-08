import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { DELETE } from "../route";

describe("DELETE /api/team-runs/:rootSessionId workspace boundary", () => {
  it("rejects destructive requests that omit workspaceId before loading the Team Run", async () => {
    const request = new NextRequest("http://localhost/api/team-runs/team-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ rootSessionId: "team-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "TEAM_RUN_WORKSPACE_REQUIRED" },
    });
  });
});
