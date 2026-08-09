/**
 * Keeps one MCP request from forcing the Next.js process to buffer an
 * unbounded JSON document. Tool results should be passed through artifacts or
 * files instead of being embedded in a JSON-RPC payload.
 */
export const MAX_MCP_REQUEST_BYTES = 8 * 1024 * 1024;

export type McpRequestBody = {
  method?: string;
  id?: unknown;
  params?: Record<string, unknown>;
};

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

export function exceedsMcpRequestLimit(request: Request): boolean {
  const contentLength = declaredContentLength(request);
  return contentLength !== null && contentLength > MAX_MCP_REQUEST_BYTES;
}

/**
 * The MCP SDK calls Request.json(), which otherwise buffers its whole body.
 * Enforce the same ceiling for chunked requests that lack Content-Length.
 */
export function limitMcpRequestBody(request: Request): Request {
  if (!request.body) return request;

  let received = 0;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_MCP_REQUEST_BYTES) {
        controller.error(new Error("MCP request body exceeds the 8 MiB limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));

  return new Request(request, { body, duplex: "half" } as RequestInit);
}

/**
 * Auto-retrying a stale session needs a replayable request body. Only make
 * that diagnostic/retry copy when the peer declared a safely bounded size.
 */
export async function readRetryableMcpRequestBody(
  request: Request,
): Promise<McpRequestBody | null> {
  const contentLength = declaredContentLength(request);
  if (contentLength === null || contentLength > MAX_MCP_REQUEST_BYTES) {
    return null;
  }

  try {
    return await request.clone().json() as McpRequestBody;
  } catch {
    return null;
  }
}
