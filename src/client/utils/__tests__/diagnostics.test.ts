/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { desktopAwareFetch } from "../diagnostics";

describe("desktopAwareFetch", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches same-origin /api paths", async () => {
    await desktopAwareFetch("/api/notes?workspaceId=ws-1");

    expect(fetch).toHaveBeenCalledWith("/api/notes?workspaceId=ws-1", undefined);
  });

  it("normalizes paths without the /api prefix before fetching", async () => {
    await desktopAwareFetch("tasks?workspaceId=ws-1");

    expect(fetch).toHaveBeenCalledWith("/api/tasks?workspaceId=ws-1", undefined);
  });

  it("passes request options through unchanged", async () => {
    const options: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };

    await desktopAwareFetch("/api/rpc", options);

    expect(fetch).toHaveBeenCalledWith("/api/rpc", options);
  });
});
