/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from "vitest";

import { resolveApiPath } from "../backend";

describe("resolveApiPath", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("passes absolute http(s) URLs through unchanged", () => {
    expect(resolveApiPath("http://example.com/api/tasks")).toBe("http://example.com/api/tasks");
    expect(resolveApiPath("https://example.com/api/tasks")).toBe("https://example.com/api/tasks");
  });

  it("normalizes relative paths onto the /api prefix", () => {
    expect(resolveApiPath("/api/tasks")).toBe("/api/tasks");
    expect(resolveApiPath("api/tasks")).toBe("/api/tasks");
    expect(resolveApiPath("/tasks")).toBe("/api/tasks");
    expect(resolveApiPath("tasks")).toBe("/api/tasks");
    expect(resolveApiPath("/api")).toBe("/api");
  });

  it("preserves query strings while normalizing the prefix", () => {
    expect(resolveApiPath("api/notes/events?workspaceId=ws-1")).toBe(
      "/api/notes/events?workspaceId=ws-1",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveApiPath("  /tasks  ")).toBe("/api/tasks");
  });

  it("honors an explicit http(s) base URL", () => {
    expect(resolveApiPath("/tasks", "http://localhost:4000")).toBe(
      "http://localhost:4000/api/tasks",
    );
    expect(resolveApiPath("api/tasks", "https://backend.example.com/")).toBe(
      "https://backend.example.com/api/tasks",
    );
  });

  it("ignores invalid explicit base URLs", () => {
    expect(resolveApiPath("/tasks", "not a url")).toBe("/api/tasks");
    expect(resolveApiPath("/tasks", "ftp://example.com")).toBe("/api/tasks");
    expect(resolveApiPath("/tasks", "")).toBe("/api/tasks");
  });

  it("stays same-origin regardless of stored or query-string backend hints", () => {
    localStorage.setItem("routa.backendBaseUrl", "http://elsewhere.example.com");
    window.history.replaceState(null, "", "/?backend=http://query.example.com");

    expect(resolveApiPath("/tasks")).toBe("/api/tasks");
  });
});
