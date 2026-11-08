import type { GitHubSource, PullRequestFacts } from "./types.ts";

export function pullRequestFacts(
  overrides: Partial<PullRequestFacts> = {},
): PullRequestFacts {
  const number = overrides.number ?? 12;

  return {
    url: `https://github.com/acme/shop/pull/${number}`,
    repo: "acme/shop",
    number,
    title: "Add gift cards",
    author: "ada",
    state: "OPEN",
    isDraft: false,
    baseRef: "main",
    headRef: "gift-cards",
    headSha: "aaaaaaa1111111",
    defaultBranch: "main",
    mergedAt: "",
    mergeSha: "",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    approvals: [],
    requestedReviewers: [],
    failingChecks: [],
    pendingChecks: 0,
    behindBy: 0,
    branchTip: "",
    unresolvedThreads: 0,
    isPartialRead: false,
    ...overrides,
  };
}

export function fakeSource(
  overrides: Partial<GitHubSource> = {},
): GitHubSource {
  const notUsed = () => Promise.reject(new Error("not used in this test"));

  return {
    name: "fake",
    pullRequest: notUsed,
    pullRequestsForBranch: () => Promise.resolve([]),
    search: notUsed,
    commitsSince: notUsed,
    latestDeployment: notUsed,
    latestWorkflowRun: notUsed,
    commitOnDefaultBranch: () => Promise.resolve(""),
    commitDate: () => Promise.resolve("2026-11-01T10:00:00Z"),
    contains: notUsed,
    ...overrides,
  };
}
