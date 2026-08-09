import { describe, expect, it } from "vitest";
import {
  exceedsMcpRequestLimit,
  limitMcpRequestBody,
  MAX_MCP_REQUEST_BYTES,
  readRetryableMcpRequestBody,
} from "../mcp-request-guard";

describe("MCP request guard", () => {
  it("rejects declared request bodies over the ceiling before parsing", () => {
    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-length": String(MAX_MCP_REQUEST_BYTES + 1) },
    });

    expect(exceedsMcpRequestLimit(request)).toBe(true);
  });

  it("aborts chunked bodies that exceed the ceiling", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MCP_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = limitMcpRequestBody(new Request("http://localhost/api/mcp", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit));

    await expect(request.text()).rejects.toThrow("exceeds the 8 MiB limit");
  });

  it("only snapshots bounded, declared request bodies for retry", async () => {
    const body = JSON.stringify({ method: "tools/call", id: 1 });
    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(body)) },
      body,
    });
    const chunkedRequest = new Request("http://localhost/api/mcp", {
      method: "POST",
      body,
    });

    await expect(readRetryableMcpRequestBody(request)).resolves.toMatchObject({ method: "tools/call", id: 1 });
    await expect(readRetryableMcpRequestBody(chunkedRequest)).resolves.toBeNull();
  });

  it("does not trust a falsely small declared content length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MCP_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = limitMcpRequestBody(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-length": "1" },
      body,
      duplex: "half",
    } as RequestInit));

    await expect(readRetryableMcpRequestBody(request)).resolves.toBeNull();
  });
});
