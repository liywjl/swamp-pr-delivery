import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { fakeSource, pullRequestFacts } from "./fixtures.ts";
import { tracePullRequest } from "./trace.ts";
import type { CommitWithStatuses, DeployedRevision, EnvironmentConfig, PullRequestFacts } from "./types.ts";

const environments: EnvironmentConfig[] = [
  { name: "staging", commitStatus: "deploy_staging" },
  { name: "production", githubDeployment: "production" },
];
const childUrl = "https://github.com/acme/shop/pull/12";
const parentUrl = "https://github.com/acme/shop/pull/11";

Deno.test("one stacked PR, from merged into a branch to production", async () => {
  const child = pullRequestFacts({ number: 12, state: "MERGED", baseRef: "checkout", mergedAt: "2026-11-02T10:00:00Z", mergeSha: "child" });
  let parent = pullRequestFacts({ number: 11, headRef: "checkout", failingChecks: ["e2e"] });
  let commits: CommitWithStatuses[] = [];
  let deployment: DeployedRevision | null = null;

  const source = fakeSource({
    pullRequest: (url: string): Promise<PullRequestFacts> => Promise.resolve(url === childUrl ? child : parent),
    pullRequestsForBranch: () => Promise.resolve([{ url: parentUrl, number: 11, state: parent.state, mergedAt: parent.mergedAt }]),
    commitsSince: () => Promise.resolve(commits),
    latestDeployment: () => Promise.resolve(deployment),
    contains: () => Promise.resolve(true),
  });
  const stage = async () => (await tracePullRequest(source, childUrl, environments, [])).stage;

  assertEquals(await stage(), "merged-into-branch");

  parent = { ...parent, state: "MERGED", mergedAt: "2026-11-02T11:00:00Z", mergeSha: "parent", failingChecks: [] };
  commits = [{ sha: "parent", statuses: [] }];

  assertEquals(await stage(), "on-default-branch");

  commits = [{ sha: "parent", statuses: [{ context: "deploy_staging", state: "SUCCESS", updatedAt: "2026-11-02T11:20:00Z" }] }];

  assertEquals(await stage(), "on-staging");

  deployment = { sha: "parent", at: "2026-11-02T12:00:00Z" };

  assertEquals(await stage(), "on-production");
});

Deno.test("a PR whose timing looks stranded is landed when its commit is on the default branch", async () => {
  const child = pullRequestFacts({ number: 12, state: "MERGED", baseRef: "checkout", mergedAt: "2026-11-02T10:00:00Z", mergeSha: "child" });
  const source = fakeSource({
    pullRequest: () => Promise.resolve(child),
    commitOnDefaultBranch: () => Promise.resolve("child"),
  });
  const delivery = await tracePullRequest(source, childUrl, [], []);

  assertEquals([delivery.stage, delivery.landedSha], ["on-default-branch", "child"]);
});

Deno.test("a merged PR with no merge commit found falls back to proving its head landed", async () => {
  const merged = pullRequestFacts({ number: 12, state: "MERGED", mergedAt: "2026-11-02T10:00:00Z", mergeSha: "" });
  const source = fakeSource({
    pullRequest: () => Promise.resolve(merged),
    commitOnDefaultBranch: () => Promise.resolve("head"),
  });

  assertEquals((await tracePullRequest(source, childUrl, [], [])).landedSha, "head");
});

Deno.test("a commit dated well before the merge is still searched from its own date", async () => {
  const merged = pullRequestFacts({ number: 12, state: "MERGED", mergedAt: "2026-11-02T10:00:00Z", mergeSha: "queued" });
  let searchedFrom = "";
  const source = fakeSource({
    pullRequest: () => Promise.resolve(merged),
    commitDate: () => Promise.resolve("2026-11-02T08:00:00Z"),
    latestWorkflowRun: () => Promise.resolve({ sha: "deployed", at: "2026-11-02T11:00:00Z" }),
    contains: (_repo, _sha, landedAt) => {
      searchedFrom = landedAt;

      return Promise.resolve(true);
    },
  });

  await tracePullRequest(source, childUrl, [{ name: "production", githubActionsWorkflow: "deploy.yml" }], []);

  assertEquals(searchedFrom, "2026-11-02T08:00:00Z");
});

Deno.test("an unreadable commit date is can't tell, not missing from the environment", async () => {
  const merged = pullRequestFacts({ number: 12, state: "MERGED", mergedAt: "2026-11-02T10:00:00Z", mergeSha: "m1" });
  const source = fakeSource({
    pullRequest: () => Promise.resolve(merged),
    commitDate: () => Promise.reject(new Error("GitHub MCP returned 503.")),
  });
  const delivery = await tracePullRequest(source, childUrl, [{ name: "production", githubActionsWorkflow: "deploy.yml" }], []);

  assertEquals(delivery.environments[0].state, "unknown");
});

Deno.test("a stack that loops stops with an error instead of hanging", async () => {
  const looping = pullRequestFacts({ number: 12, state: "MERGED", baseRef: "loop", mergedAt: "2026-11-02T10:00:00Z" });
  const other = pullRequestFacts({ number: 13, state: "MERGED", baseRef: "loop", mergedAt: "2026-11-02T10:00:00Z" });
  const source = fakeSource({
    pullRequest: (url: string) => Promise.resolve(url === childUrl ? looping : other),
    pullRequestsForBranch: (_repo: string, _branch: string) => Promise.resolve([
      { url: "https://github.com/acme/shop/pull/13", number: 13, state: "MERGED" as const, mergedAt: "2026-11-02T10:00:00Z" },
      { url: childUrl, number: 12, state: "MERGED" as const, mergedAt: "2026-11-02T10:00:00Z" },
    ]),
  });
  const message = await tracePullRequest(source, childUrl, [], []).catch((error) => error.message);

  assertEquals(message, `${childUrl} is stacked more than 20 deep.`);
});
