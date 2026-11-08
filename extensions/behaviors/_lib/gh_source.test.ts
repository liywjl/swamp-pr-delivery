import { deepStrictEqual as assertEquals, rejects } from "node:assert/strict";
import { pullRequestFacts } from "./fixtures.ts";
import { createGhSource } from "./gh_source.ts";

const url = "https://github.com/acme/shop/pull/12";

function view(overrides: Record<string, unknown> = {}) {
  return {
    url,
    number: 12,
    title: "Add gift cards",
    author: { login: "ada" },
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: "gift-cards",
    headRefOid: "head1",
    mergedAt: null,
    mergeCommit: null,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewRequests: [{ login: "grace" }, { slug: "platform" }],
    statusCheckRollup: [
      { name: "unit", conclusion: "FAILURE" },
      { context: "lint", state: "PENDING" },
      { name: "types", conclusion: "SUCCESS" },
    ],
    ...overrides,
  };
}

function runner(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);

    const key = Object.keys(answers).find((candidate) => args.join(" ").includes(candidate));

    return key ? Promise.resolve(answers[key]) : Promise.reject(new Error(`unexpected: ${args.join(" ")}`));
  };

  return { run, calls };
}

const threads = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } } } } };

Deno.test("an open PR is read with reviews, branch tip, staleness and threads", async () => {
  const { run } = runner({
    "pr view": view(),
    "pulls/12/reviews": [
      { user: { login: "grace" }, state: "APPROVED", commit_id: "old" },
      { user: { login: "alan" }, state: "COMMENTED", commit_id: "head1" },
    ],
    "branches/gift-cards": { commit: { sha: "tip1" } },
    "compare/main...gift-cards": { behind_by: 4 },
    "reviewThreads": threads,
    "repos/acme/shop": { default_branch: "main" },
  });
  const facts = await createGhSource(run).pullRequest(url);

  assertEquals(facts.approvals, [{ who: "grace", commit: "old" }]);
  assertEquals(facts.failingChecks, ["unit"]);
  assertEquals(facts.pendingChecks, 1);
  assertEquals([facts.branchTip, facts.behindBy, facts.unresolvedThreads], ["tip1", 4, 1]);
  assertEquals(facts.requestedReviewers, ["grace", "platform"]);
});

Deno.test("a fork's branch isn't looked up in the base repo", async () => {
  const { run, calls } = runner({
    "pr view": view({ isCrossRepository: true }),
    "pulls/12/reviews": [],
    "compare/main...gift-cards": { behind_by: 0 },
    "reviewThreads": threads,
    "repos/acme/shop": { default_branch: "main" },
  });
  const facts = await createGhSource(run).pullRequest(url);

  assertEquals(facts.branchTip, "");
  assertEquals(calls.some((args) => args.join(" ").includes("branches/")), false);
});

Deno.test("commit history stops at the page holding the landed commit", async () => {
  const page = (oids: string[], hasNextPage: boolean) => ({
    data: { repository: { ref: { target: { history: { pageInfo: { hasNextPage, endCursor: "next" }, nodes: oids.map((oid) => ({ oid, status: null })) } } } } },
  });
  let served = 0;
  const run = () => Promise.resolve(served++ === 0 ? page(["c3", "c2"], true) : page(["landed", "c0"], true));
  const commits = await createGhSource(run).commitsSince("acme/shop", "main", "2026-11-01T00:00:00Z", "landed");

  assertEquals(commits.map((commit) => commit.sha), ["c3", "c2", "landed", "c0"]);
  assertEquals(served, 2);
});

Deno.test("the latest successful deployment skips failed ones", async () => {
  const { run } = runner({
    "deployments/2/statuses": [{ state: "failure", created_at: "2026-11-02T10:00:00Z" }],
    "deployments/1/statuses": [{ state: "success", created_at: "2026-11-01T10:00:00Z" }],
    "deployments?environment=production": [{ id: 2, sha: "new" }, { id: 1, sha: "old" }],
  });

  assertEquals(await createGhSource(run).latestDeployment("acme/shop", "production"), { sha: "old", at: "2026-11-01T10:00:00Z" });
});

Deno.test("parents are looked up only among the repo's own branches", async () => {
  const { run, calls } = runner({
    "/pulls?head=": [{ html_url: "https://github.com/acme/shop/pull/9", number: 9, state: "closed", merged_at: "2026-11-01T10:00:00Z" }],
  });
  const found = await createGhSource(run).pullRequestsForBranch("acme/shop", "feature/develop");

  assertEquals(found, [{ url: "https://github.com/acme/shop/pull/9", number: 9, state: "MERGED", mergedAt: "2026-11-01T10:00:00Z" }]);
  assertEquals(calls[0][1], "repos/acme/shop/pulls?head=acme%3Afeature%2Fdevelop&state=all&per_page=100");
});

Deno.test("a refused review read fails the PR instead of claiming nobody approved", async () => {
  const run = (args: string[]) => {
    const call = args.join(" ");

    if (call.includes("/reviews")) return Promise.reject(new Error("gh failed: HTTP 403"));
    if (call.includes("pr view")) return Promise.resolve(view());
    if (call.includes("reviewThreads")) return Promise.resolve(threads);
    if (call.includes("/branches/")) return Promise.resolve({ commit: { sha: "tip1" } });
    if (call.includes("/compare/")) return Promise.resolve({ behind_by: 0 });

    return Promise.resolve({ default_branch: "main" });
  };

  await rejects(createGhSource(run).pullRequest(url), /HTTP 403/);
});

Deno.test("a commit that doesn't exist isn't on the default branch", async () => {
  const run = () => Promise.reject(new Error("gh failed: HTTP 404"));
  const pr = pullRequestFacts({ state: "MERGED", mergeSha: "gone", headSha: "gone2" });

  assertEquals(await createGhSource(run).commitOnDefaultBranch(pr), "");
});

Deno.test("a refused commit check fails instead of calling the PR stranded", async () => {
  const run = () => Promise.reject(new Error("gh failed: HTTP 403"));
  const pr = pullRequestFacts({ state: "MERGED", mergeSha: "m1" });

  await rejects(createGhSource(run).commitOnDefaultBranch(pr), /HTTP 403/);
});

Deno.test("a repo name that looks numeric is passed as text", async () => {
  const { run, calls } = runner({
    "pr view": view(),
    "pulls/12/reviews": [],
    "branches/gift-cards": { commit: { sha: "tip1" } },
    "compare/main...gift-cards": { behind_by: 0 },
    "reviewThreads": threads,
    "repos/acme/shop": { default_branch: "main" },
  });

  await createGhSource(run).pullRequest(url);

  const graphqlCall = calls.find((args) => args.join(" ").includes("reviewThreads"))!;

  assertEquals(graphqlCall[graphqlCall.indexOf("owner=acme") - 1], "-f");
});

Deno.test("a deploy behind the landed commit doesn't contain it", async () => {
  const { run } = runner({ "compare/landed...deployed": { status: "behind" } });

  assertEquals(await createGhSource(run).contains("acme/shop", "landed", "", "deployed"), false);
});
