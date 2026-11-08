import { deepStrictEqual as assertEquals, rejects } from "node:assert/strict";
import { createMcpClient, type Fetcher } from "./mcp_client.ts";

const secret = "not-a-real-token";

function fetcher(toolResponse: (id: number) => Response) {
  const requests: { headers: Record<string, string>; body: { id?: number; method: string } }[] = [];
  const fake: Fetcher = (_url, init) => {
    const body = JSON.parse(init.body as string);

    requests.push({ headers: init.headers as Record<string, string>, body });

    if (body.method === "initialize") {
      return Promise.resolve(new Response(JSON.stringify({ id: body.id, result: {} }), { headers: { "mcp-session-id": "s1" } }));
    }

    if (body.method === "notifications/initialized") return Promise.resolve(new Response("", { status: 202 }));

    return Promise.resolve(toolResponse(body.id));
  };

  return { fake, requests };
}

const textResult = (id: number, text: string, isError = false) => ({ id, result: { isError, content: [{ type: "text", text }] } });

Deno.test("a tool answer in JSON is parsed", async () => {
  const { fake } = fetcher((id) => new Response(JSON.stringify(textResult(id, '{"ok":true}'))));

  assertEquals(await createMcpClient("https://mcp.test", secret, fake).call("get_me", {}), { ok: true });
});

Deno.test("a tool answer over server-sent events is parsed", async () => {
  const { fake } = fetcher((id) => new Response(`event: message\ndata: ${JSON.stringify(textResult(id, "[1]"))}\n\n`));

  assertEquals(await createMcpClient("https://mcp.test", secret, fake).call("get_me", {}), [1]);
});

Deno.test("every call is read-only and carries the session", async () => {
  const { fake, requests } = fetcher((id) => new Response(JSON.stringify(textResult(id, "{}"))));

  await createMcpClient("https://mcp.test", secret, fake).call("get_me", {});

  const last = requests.at(-1)!;

  assertEquals([last.headers["x-mcp-readonly"], last.headers["mcp-session-id"]], ["true", "s1"]);
});

Deno.test("the session starts once across calls", async () => {
  const { fake, requests } = fetcher((id) => new Response(JSON.stringify(textResult(id, "{}"))));
  const client = createMcpClient("https://mcp.test", secret, fake);

  await Promise.all([client.call("a", {}), client.call("b", {})]);

  assertEquals(requests.filter((request) => request.body.method === "initialize").length, 1);
});

Deno.test("a tool error is raised with its message", async () => {
  const { fake } = fetcher((id) => new Response(JSON.stringify(textResult(id, "not found", true))));

  await rejects(createMcpClient("https://mcp.test", secret, fake).call("get_me", {}), { message: "GitHub MCP get_me failed: not found" });
});

Deno.test("a brief 503 is retried", async () => {
  let attempts = 0;
  const { fake } = fetcher((id) => {
    attempts++;

    return attempts === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(textResult(id, "[2]")));
  });

  assertEquals(await createMcpClient("https://mcp.test", secret, fake, 0).call("get_me", {}), [2]);
});

Deno.test("a 503 that doesn't clear is raised", async () => {
  const { fake } = fetcher(() => new Response("busy", { status: 503 }));

  await rejects(createMcpClient("https://mcp.test", secret, fake, 0).call("get_me", {}), { message: "GitHub MCP returned 503." });
});

Deno.test("a rate limit is retried", async () => {
  let attempts = 0;
  const { fake } = fetcher((id) => {
    attempts++;

    return attempts === 1 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify(textResult(id, "[3]")));
  });

  assertEquals(await createMcpClient("https://mcp.test", secret, fake, 0).call("get_me", {}), [3]);
});

Deno.test("a failed start isn't remembered for the next call", async () => {
  let refused = true;
  const { fake } = fetcher((id) => new Response(JSON.stringify(textResult(id, "[4]"))));
  const flaky: Fetcher = (url, init) => {
    if (refused) {
      refused = false;

      return Promise.resolve(new Response("no", { status: 401 }));
    }

    return fake(url, init);
  };
  const client = createMcpClient("https://mcp.test", secret, flaky, 0);

  await rejects(client.call("get_me", {}));

  assertEquals(await client.call("get_me", {}), [4]);
});

Deno.test("a refused token never appears in the error", async () => {
  const refuse: Fetcher = () => Promise.resolve(new Response(`bad token ${secret}`, { status: 401 }));

  await rejects(createMcpClient("https://mcp.test", secret, refuse).call("get_me", {}), (error: Error) => !error.message.includes(secret));
});
