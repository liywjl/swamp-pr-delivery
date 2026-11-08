import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { createMcpSource, mergeableFrom, mergeCommitIn, reviewDecisionFrom } from "./mcp_source.ts";
import { pullRequestFacts } from "./fixtures.ts";

const url = "https://github.com/acme/shop/pull/12";

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Add gift cards",
    state: "open",
    draft: false,
    merged: false,
    mergeable_state: "blocked",
    html_url: url,
    user: { login: "ada" },
    requested_reviewers: ["grace"],
    head: { ref: "gift-cards", sha: "head1", repo: { full_name: "acme/shop" } },
    base: { ref: "main" },
    ...overrides,
  };
}

function client(pr: unknown, extra: Record<string, unknown> = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const answers: Record<string, unknown> = {
    "pull_request_read:get": pr,
    "pull_request_read:get_reviews": [{ state: "APPROVED", user: "grace", commit_id: "old" }, { state: "COMMENTED", user: "alan", commit_id: "head1" }],
    "pull_request_read:get_review_comments": { review_threads: [{ is_resolved: false }] },
    "pull_request_read:get_check_runs": { check_runs: [{ name: "unit", status: "completed", conclusion: "failure" }, { name: "e2e", status: "in_progress" }] },
    "pull_request_read:get_status": { statuses: [{ context: "lint", state: "success" }] },
    "get_commit:": { sha: "tip1" },
    "search_repositories:": { items: [{ default_branch: "main" }] },
    ...extra,
  };
  const call = (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });

    return Promise.resolve(answers[`${tool}:${args.method ?? ""}`]);
  };

  return { call, calls };
}

Deno.test("an open PR over MCP has the same facts as over gh", async () => {
  const facts = await createMcpSource(client(pullRequest())).pullRequest(url);

  assertEquals(facts.state, "OPEN");
  assertEquals(facts.failingChecks, ["unit"]);
  assertEquals(facts.pendingChecks, 1);
  assertEquals(facts.approvals, [{ who: "grace", commit: "old" }]);
  assertEquals([facts.branchTip, facts.unresolvedThreads, facts.defaultBranch], ["tip1", 1, "main"]);
});

Deno.test("a fork's branch isn't looked up over MCP", async () => {
  const fake = client(pullRequest({ head: { ref: "gift-cards", sha: "head1", repo: { full_name: "someone/shop" } } }));
  const facts = await createMcpSource(fake).pullRequest(url);

  assertEquals(facts.branchTip, "");
  assertEquals(fake.calls.some((entry) => entry.tool === "get_commit"), false);
});

Deno.test("a merged PR finds its merge commit from the base branch", async () => {
  const merged = pullRequest({ state: "closed", merged: true, merged_at: "2026-11-02T10:00:00Z", mergeable_state: "unknown" });
  const fake = client(merged, { "list_commits:": [{ sha: "other", commit: { message: "Fix (#9)" } }, { sha: "m12", commit: { message: "Add gift cards (#12)" } }] });
  const facts = await createMcpSource(fake).pullRequest(url);

  assertEquals([facts.state, facts.mergeSha], ["MERGED", "m12"]);
});

Deno.test("a PR merged into a deleted branch still reads", async () => {
  const merged = pullRequest({ state: "closed", merged: true, merged_at: "2026-11-02T10:00:00Z", mergeable_state: "unknown", base: { ref: "deleted-branch" } });
  const failing = client(merged);
  const fake = { call: (tool: string, args: Record<string, unknown>) => tool === "list_commits" ? Promise.reject(new Error("failed to list commits: 404 Not Found []")) : failing.call(tool, args) };
  const facts = await createMcpSource(fake).pullRequest(url);

  assertEquals(facts.mergeSha, "");
});

Deno.test("a head commit found on the default branch proves it landed", async () => {
  const fake = client(pullRequest(), {
    "get_commit:": { commit: { committer: { date: "2026-11-01T09:00:00Z" } } },
    "list_commits:": [{ sha: "head1" }],
  });
  const sha = await createMcpSource(fake).commitOnDefaultBranch(pullRequestFacts({ headSha: "head1", mergedAt: "2026-11-02T10:00:00Z" }));

  assertEquals(sha, "head1");
});

Deno.test("a merge commit message wins over the head commit", () => {
  const commits = [{ sha: "merge", commit: { message: "Merge pull request #12 from acme/gift-cards" } }, { sha: "head1", commit: { message: "Add gift cards" } }];

  assertEquals(mergeCommitIn(commits, 12, "head1"), "merge");
});

Deno.test("a revert that quotes the PR isn't its merge commit", () => {
  assertEquals(mergeCommitIn([{ sha: "revert", commit: { message: 'Revert "Add gift cards (#12)" (#34)' } }], 12, "head1"), "");
});

Deno.test("too many commits to confirm fails instead of calling the PR stranded", async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ sha: `c${index}` }));
  const fake = client(pullRequest(), { "list_commits:": fullPage });
  const pr = pullRequestFacts({ state: "MERGED", mergeSha: "m1", mergedAt: "2026-11-02T10:00:00Z" });
  const message = await createMcpSource(fake).commitOnDefaultBranch(pr).catch((error) => error.message);

  assertEquals(message, "Too many commits since m1 to confirm it reached main over MCP. Use transport gh.");
});

Deno.test("PR 12 doesn't match a message about PR 123", () => {
  assertEquals(mergeCommitIn([{ sha: "merge", commit: { message: "Merge pull request #123 from acme/x" } }], 12, "head1"), "");
});

Deno.test("with no message match the head commit is used when it reached the branch", () => {
  assertEquals(mergeCommitIn([{ sha: "head1", commit: { message: "Add gift cards" } }], 12, "head1"), "head1");
});

Deno.test("blocked with green checks and no open threads means a review is needed", () => {
  assertEquals(reviewDecisionFrom([], "blocked", false, false), "REVIEW_REQUIRED");
});

Deno.test("blocked with no approvals still needs a review when threads are open", () => {
  assertEquals(reviewDecisionFrom([], "blocked", false, true), "REVIEW_REQUIRED");
});

Deno.test("blocked with an approval and open threads doesn't blame the review", () => {
  assertEquals(reviewDecisionFrom([{ who: "grace", state: "APPROVED", commit: "a" }], "blocked", false, true), "APPROVED");
});

Deno.test("blocked by failing checks doesn't claim a review is needed", () => {
  assertEquals(reviewDecisionFrom([], "blocked", true, false), "NONE");
});

Deno.test("changes requested wins over other approvals", () => {
  const decisions = [{ who: "grace", state: "APPROVED", commit: "a" }, { who: "alan", state: "CHANGES_REQUESTED", commit: "a" }];

  assertEquals(reviewDecisionFrom(decisions, "clean", false, false), "CHANGES_REQUESTED");
});

Deno.test("mergeable_state dirty is a conflict and unknown is a stuck check", () => {
  assertEquals([mergeableFrom("dirty"), mergeableFrom("unknown"), mergeableFrom("clean")], ["CONFLICTING", "UNKNOWN", "MERGEABLE"]);
});

Deno.test("commit statuses are refused with a way forward", async () => {
  const message = await createMcpSource(client(pullRequest())).commitsSince("acme/shop", "main", "", "").catch((error) => error.message);

  assertEquals(message, "GitHub's MCP server has no tool for commit statuses. Use transport gh, or a githubActionsWorkflow environment.");
});

Deno.test("contains finds the landed commit in the deployed history", async () => {
  const fake = client(pullRequest(), { "list_commits:": [{ sha: "deployed" }, { sha: "landed" }] });

  assertEquals(await createMcpSource(fake).contains("acme/shop", "landed", "2026-11-02T10:00:00Z", "deployed"), true);
});

Deno.test("contains is false when the deployed history ends without it", async () => {
  const fake = client(pullRequest(), { "list_commits:": [{ sha: "deployed" }] });

  assertEquals(await createMcpSource(fake).contains("acme/shop", "landed", "2026-11-02T10:00:00Z", "deployed"), false);
});

Deno.test("contains can't tell after too many pages", async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ sha: `c${index}` }));
  const fake = client(pullRequest(), { "list_commits:": fullPage });

  assertEquals(await createMcpSource(fake).contains("acme/shop", "landed", "2026-11-02T10:00:00Z", "deployed"), null);
});
