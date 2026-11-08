export type McpClient = {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
};

export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

type JsonRpcMessage = {
  id?: number;
  result?: {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  error?: { message: string };
};

const protocolVersion = "2025-06-18";
const callTimeoutMs = 45_000;
const toolsets = "repos,pull_requests,actions";
const retryableStatuses = [429, 502, 503, 504];
const maxRetryWaitMs = 30_000;
const maxAttempts = 3;

function messagesIn(body: string): JsonRpcMessage[] {
  const trimmed = body.trim();

  if (!trimmed) return [];
  if (trimmed.startsWith("{")) return [JSON.parse(trimmed)];

  return trimmed.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
}

function textOf(message: JsonRpcMessage): string {
  return message.result?.content?.find((part) => part.type === "text")?.text ??
    "";
}

function parseToolText(tool: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub MCP returned something unreadable from ${tool}.`);
  }
}

export function createMcpClient(
  url: string,
  token: string,
  fetcher: Fetcher = fetch,
  retryDelayMs = 1000,
): McpClient {
  let nextId = 1;
  let session: Promise<string> | null = null;

  const send = (
    payload: Record<string, unknown>,
    sessionId: string,
  ): Promise<Response> =>
    fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-mcp-toolsets": toolsets,
        "x-mcp-readonly": "true",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
      signal: AbortSignal.timeout(callTimeoutMs),
    });

  const sendWithRetries = async (
    payload: Record<string, unknown>,
    sessionId: string,
  ): Promise<Response> => {
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      const response = await send(payload, sessionId);

      if (!retryableStatuses.includes(response.status)) return response;

      const retryAfterMs = Number(response.headers.get("retry-after")) * 1000;
      const waitMs = Math.min(
        Math.max(retryAfterMs || 0, retryDelayMs * attempt),
        maxRetryWaitMs,
      );

      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return send(payload, sessionId);
  };

  const post = async (
    payload: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ body: string; sessionId: string }> => {
    const response = await sendWithRetries(payload, sessionId);
    const body = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitHub MCP refused the token (${response.status}). Check mcpToken and its repo scope.`,
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub MCP returned ${response.status}.`);
    }

    return {
      body,
      sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    };
  };

  const startSession = async (): Promise<string> => {
    const initialized = await post({
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "pr-delivery", version: "1" },
      },
    }, "");

    await post({ method: "notifications/initialized" }, initialized.sessionId);

    return initialized.sessionId;
  };

  const call = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    session ??= startSession().catch((error) => {
      session = null;

      throw error;
    });

    const sessionId = await session;
    const id = nextId++;
    const { body } = await post({
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }, sessionId);
    const message = messagesIn(body).find((candidate) => candidate.id === id);

    if (!message) throw new Error(`GitHub MCP didn't answer ${tool}.`);
    if (message.error) {
      throw new Error(`GitHub MCP ${tool} failed: ${message.error.message}`);
    }
    if (message.result?.isError) {
      throw new Error(`GitHub MCP ${tool} failed: ${textOf(message)}`);
    }

    return parseToolText(tool, textOf(message));
  };

  return { call };
}
