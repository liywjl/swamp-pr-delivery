import { deepStrictEqual as assertEquals, rejects } from "node:assert/strict";
import { behavior } from "./pr_delivery.ts";

const mcpArgs = {
  transport: "mcp" as const,
  mcpUrl: "https://mcp.test/",
  mcpToken: "not-a-real-token",
  environments: [],
};
const goodUrl = "https://github.com/acme/shop/pull/12";
const badUrl = "https://github.com/acme/shop/pull/13";

function contextWith(globalArgs: unknown) {
  const written: { spec: string; name: string; data: Record<string, unknown> }[] = [];
  const context = {
    globalArgs,
    logger: { info: () => {}, warn: () => {} },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      written.push({ spec, name, data });

      return Promise.resolve({ name });
    },
  };

  return { context: context as never, written };
}

function toolAnswer(id: number, tool: string, args: Record<string, unknown>) {
  const isBadPullRequest = tool === "pull_request_read" && args.pullNumber === 13;
  const answers: Record<string, unknown> = {
    search_repositories: { items: [{ default_branch: "main" }] },
    list_commits: [{ sha: "m12", commit: { message: "Add gift cards (#12)" } }],
    pull_request_read: {
      number: 12,
      title: "Add gift cards",
      state: "closed",
      draft: false,
      merged: true,
      mergeable_state: "unknown",
      html_url: goodUrl,
      user: { login: "ada" },
      head: { ref: "gift-cards", sha: "head1" },
      base: { ref: "main" },
      merged_at: "2026-11-02T10:00:00Z",
    },
  };
  const text = isBadPullRequest ? "not found" : JSON.stringify(answers[tool]);

  return { id, result: { isError: isBadPullRequest, content: [{ type: "text", text }] } };
}

async function withFakeGitHub(run: () => Promise<void>) {
  const realFetch = globalThis.fetch;

  globalThis.fetch = ((input: string, init: RequestInit) => {
    if (input !== mcpArgs.mcpUrl) return Promise.resolve(new Response("{}", { status: 500 }));

    const body = JSON.parse(init.body as string);

    if (body.method === "tools/call") {
      return Promise.resolve(new Response(JSON.stringify(toolAnswer(body.id, body.params.name, body.params.arguments))));
    }

    return Promise.resolve(new Response(JSON.stringify({ id: body.id, result: {} }), { headers: { "mcp-session-id": "s1" } }));
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const execute = behavior.methods.trace.execute as (args: unknown, context: never) => Promise<{ dataHandles: unknown[] }>;

Deno.test("trace writes one validated delivery per PR", async () => {
  await withFakeGitHub(async () => {
    const { context, written } = contextWith(mcpArgs);

    await execute({ urls: [goodUrl], query: "", limit: 30 }, context);

    assertEquals(written.map((item) => [item.spec, item.name, item.data.stage]), [["delivery", "acme--shop-12", "on-default-branch"]]);
  });
});

Deno.test("trace keeps the PRs it could read and reports the ones it couldn't", async () => {
  await withFakeGitHub(async () => {
    const { context, written } = contextWith(mcpArgs);

    await rejects(execute({ urls: [goodUrl, badUrl], query: "", limit: 30 }, context), /Couldn't read 1 of 2 PRs/);

    assertEquals(written.length, 1);
  });
});

Deno.test("transport mcp without a token says what's missing", async () => {
  const { context } = contextWith({ ...mcpArgs, mcpToken: undefined });

  await rejects(execute({ urls: [goodUrl], query: "", limit: 30 }, context), { message: "transport mcp needs mcpToken, usually from a vault." });
});

Deno.test("trace with nothing to read says so", async () => {
  const { context } = contextWith({ ...mcpArgs });

  await rejects(execute({ urls: [], query: "", limit: 30 }, context), { message: "Give urls or a query that finds PRs." });
});

Deno.test("an environment needs exactly one way to prove it", () => {
  const parse = (environment: Record<string, unknown>) => behavior.globalArguments.safeParse({ environments: [environment] }).success;

  assertEquals(parse({ name: "staging", commitStatus: "deploy" }), true);
  assertEquals(parse({ name: "staging" }), false);
  assertEquals(parse({ name: "staging", commitStatus: "deploy", githubDeployment: "staging" }), false);
});

Deno.test("environment names must be unique", () => {
  const environments = [{ name: "staging", commitStatus: "a" }, { name: "staging", commitStatus: "b" }];

  assertEquals(behavior.globalArguments.safeParse({ environments }).success, false);
});

Deno.test("the token never goes to a plain http server, except this machine", () => {
  const parse = (mcpUrl: string) => behavior.globalArguments.safeParse({ mcpUrl }).success;

  assertEquals(parse("http://mcp.example.com/"), false);
  assertEquals(parse("http://localhost:8082/"), true);
  assertEquals(parse("https://mcp.example.com/"), true);
});

Deno.test("the token is marked sensitive so it goes through a vault", () => {
  const shape = behavior.globalArguments.shape.mcpToken;

  assertEquals(shape.unwrap().meta()?.sensitive, true);
});
