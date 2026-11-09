import { z } from "npm:zod@4.3.6";
import { createGhSource, runGh } from "./_lib/gh_source.ts";
import { createMcpClient } from "./_lib/mcp_client.ts";
import { createMcpSource } from "./_lib/mcp_source.ts";
import {
  activeGitHubIncidents,
  dataNameOf,
  tracePullRequest,
} from "./_lib/trace.ts";
import type { EnvironmentConfig, GitHubSource } from "./_lib/types.ts";

function isSafeMcpUrl(url: string): boolean {
  const { protocol, hostname } = new URL(url);

  return protocol === "https:" || ["localhost", "127.0.0.1"].includes(hostname);
}

const EnvironmentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  commitStatus: z.string().min(1).optional(),
  githubDeployment: z.string().min(1).optional(),
  githubActionsWorkflow: z.string().min(1).optional(),
}).refine(
  (environment) =>
    [
      environment.commitStatus,
      environment.githubDeployment,
      environment.githubActionsWorkflow,
    ].filter(Boolean).length === 1,
  "Give exactly one of commitStatus, githubDeployment or githubActionsWorkflow",
);

const GlobalArgsSchema = z.object({
  transport: z.enum(["gh", "mcp"]).default("gh"),
  mcpUrl: z.string().url().default("https://api.githubcopilot.com/mcp/").refine(
    isSafeMcpUrl,
    "mcpUrl must use https, unless it points at this machine",
  ),
  mcpToken: z.string().meta({ sensitive: true }).optional(),
  environments: z.array(EnvironmentSchema).default([]).refine(
    (environments) =>
      new Set(environments.map((environment) => environment.name)).size ===
        environments.length,
    "Environment names must be unique",
  ),
});

const TraceArgsSchema = z.object({
  urls: z.array(z.string()).default([]),
  query: z.string().default(""),
  limit: z.number().int().min(1).max(100).default(30),
});

const DeliverySchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  stage: z.string(),
  where: z.string(),
  blockedBy: z.object({ url: z.string(), label: z.string() }).nullable(),
  blockers: z.array(z.object({ kind: z.string(), text: z.string() })),
  mergedAt: z.string(),
  landedSha: z.string(),
  isPartialRead: z.boolean(),
  environments: z.array(z.object({
    name: z.string(),
    state: z.enum(["deployed", "deploying", "failed", "not-yet", "unknown"]),
    at: z.string(),
    detail: z.string(),
  })),
  source: z.string(),
  checkedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type TraceArgs = z.infer<typeof TraceArgsSchema>;

type BehaviorContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, values?: Record<string, unknown>) => void;
    warn: (message: string, values?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

function sourceFor(globalArgs: GlobalArgs): GitHubSource {
  if (globalArgs.transport === "gh") return createGhSource(runGh);

  if (!globalArgs.mcpToken) {
    throw new Error("transport mcp needs mcpToken, usually from a vault.");
  }

  return createMcpSource(
    createMcpClient(globalArgs.mcpUrl, globalArgs.mcpToken),
  );
}

async function targetUrls(
  source: GitHubSource,
  args: TraceArgs,
): Promise<string[]> {
  const found = args.query ? await source.search(args.query, args.limit) : [];
  const urls = [...new Set([...args.urls, ...found])];

  if (urls.length === 0) {
    throw new Error("Give urls or a query that finds PRs.");
  }

  return urls;
}

async function trace(args: TraceArgs, context: BehaviorContext) {
  const source = sourceFor(context.globalArgs);
  const urls = await targetUrls(source, args);
  const incidents = await activeGitHubIncidents();
  const environments = context.globalArgs.environments as EnvironmentConfig[];

  context.logger.info("Tracing {count} PRs over {transport}", {
    count: urls.length,
    transport: source.name,
  });

  const dataHandles: unknown[] = [];
  const failures: string[] = [];

  for (const url of urls) {
    try {
      const delivery = await tracePullRequest(
        source,
        url,
        environments,
        incidents,
      );

      context.logger.info("{url}: {stage}", { url, stage: delivery.stage });
      dataHandles.push(
        await context.writeResource(
          "delivery",
          dataNameOf(delivery),
          DeliverySchema.parse(delivery),
        ),
      );
    } catch (error) {
      const reason = (error as Error).message;

      context.logger.warn("{url}: couldn't read it: {reason}", { url, reason });
      failures.push(`${url}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Couldn't read ${failures.length} of ${urls.length} PRs:\n${
        failures.join("\n")
      }`,
    );
  }

  return { dataHandles };
}

/** Traces pull requests from review to each deployed environment. */
export const behavior = {
  type: "@liywjl/pr-delivery",
  version: "2026.11.09.1",
  upgrades: [
    {
      toVersion: "2026.11.09.1",
      description: "Version bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    delivery: {
      description:
        "Where one pull request's code really is, and what is stopping it",
      schema: DeliverySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    trace: {
      description:
        "Follow pull requests through stacked branches to the default branch and each environment, and explain what blocks open ones. Read-only",
      arguments: TraceArgsSchema,
      execute: trace,
    },
  },
};
