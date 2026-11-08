import {
  approvalsOf,
  checkOutcome,
  latestDecisions,
  nullWhenMissing,
  parsePullRequestUrl,
  restState,
  type Review,
} from "./github_facts.ts";
import type { McpClient } from "./mcp_client.ts";
import type {
  DeployedRevision,
  GitHubSource,
  ParentCandidate,
  PullRequestFacts,
} from "./types.ts";

type McpPullRequest = {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable_state: string;
  html_url: string;
  user?: { login: string };
  requested_reviewers?: string[];
  head: { ref: string; sha: string; repo?: { full_name: string } };
  base: { ref: string };
  merged_at?: string | null;
};

type McpReview = {
  state: string;
  user?: string | { login: string };
  commit_id: string;
};

type McpCommit = { sha: string; commit?: { message?: string } };

type OpenDetails = Pick<
  PullRequestFacts,
  | "approvals"
  | "reviewDecision"
  | "failingChecks"
  | "pendingChecks"
  | "branchTip"
  | "unresolvedThreads"
  | "isPartialRead"
>;

const mergeWindowMs = 5 * 60_000;
const commitsPerPage = 100;
const maxContainsPages = 5;
const landedSearchMarginMs = 10 * 60_000;

function shiftedIso(iso: string, offsetMs: number): string {
  return new Date(Date.parse(iso) + offsetMs).toISOString();
}

function reviewer(review: McpReview): string {
  return typeof review.user === "string"
    ? review.user
    : review.user?.login ?? "";
}

export function reviewDecisionFrom(
  decisions: Review[],
  mergeableState: string,
  hasUnsettledChecks: boolean,
  hasUnresolvedThreads: boolean,
): string {
  const hasChangesRequested = decisions.some((review) =>
    review.state === "CHANGES_REQUESTED"
  );

  if (hasChangesRequested) return "CHANGES_REQUESTED";

  const hasApprovals = approvalsOf(decisions).length > 0;
  const isReviewTheLikelyBlock = !hasApprovals || !hasUnresolvedThreads;
  const isBlockedOnReview = mergeableState === "blocked" &&
    !hasUnsettledChecks && isReviewTheLikelyBlock;

  if (isBlockedOnReview) return "REVIEW_REQUIRED";

  return hasApprovals ? "APPROVED" : "NONE";
}

export function mergeableFrom(mergeableState: string): string {
  if (mergeableState === "dirty") return "CONFLICTING";
  if (mergeableState === "unknown") return "UNKNOWN";

  return "MERGEABLE";
}

export function mergeCommitIn(
  commits: McpCommit[],
  number: number,
  headSha: string,
): string {
  const mentionsPullRequest = (commit: McpCommit): boolean => {
    const firstLine = (commit.commit?.message ?? "").split("\n")[0];

    return firstLine.endsWith(`(#${number})`) ||
      firstLine.startsWith(`Merge pull request #${number} `);
  };
  const byMessage = commits.find(mentionsPullRequest);

  if (byMessage) return byMessage.sha;

  return commits.find((commit) => commit.sha === headSha)?.sha ?? "";
}

function unsupported(evidence: string): Error {
  return new Error(
    `GitHub's MCP server has no tool for ${evidence}. Use transport gh, or a githubActionsWorkflow environment.`,
  );
}

export function createMcpSource(client: McpClient): GitHubSource {
  const defaultBranches = new Map<string, Promise<string>>();

  const defaultBranch = (repo: string): Promise<string> => {
    const known = defaultBranches.get(repo);

    if (known) return known;

    const found = (client.call("search_repositories", {
      query: `repo:${repo}`,
      minimal_output: true,
    }) as Promise<{ items: { default_branch: string }[] }>).then((response) => {
      const [item] = response.items;

      if (!item) throw new Error(`GitHub MCP can't see ${repo}.`);

      return item.default_branch;
    });

    defaultBranches.set(repo, found);

    return found;
  };

  const read = (
    repo: string,
    number: number,
    method: string,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const [owner, name] = repo.split("/");

    return client.call("pull_request_read", {
      owner,
      repo: name,
      pullNumber: number,
      method,
      ...extra,
    });
  };

  const openDetails = async (
    repo: string,
    view: McpPullRequest,
  ): Promise<OpenDetails> => {
    const [owner, name] = repo.split("/");
    const isCrossRepository = view.head.repo !== undefined &&
      view.head.repo.full_name !== repo;
    const [reviews, threads, checkRuns, combined, branch] = await Promise.all([
      read(repo, view.number, "get_reviews", { perPage: 100 }) as Promise<
        McpReview[]
      >,
      read(repo, view.number, "get_review_comments", {
        perPage: 100,
      }) as Promise<
        { review_threads: { is_resolved: boolean }[] }
      >,
      read(repo, view.number, "get_check_runs", { perPage: 100 }) as Promise<
        {
          check_runs: {
            name: string;
            status: string;
            conclusion?: string | null;
          }[];
        }
      >,
      read(repo, view.number, "get_status") as Promise<
        { statuses: { context: string; state: string }[] }
      >,
      isCrossRepository ? null : (client.call("get_commit", {
        owner,
        repo: name,
        sha: view.head.ref,
        detail: "none",
      }) as Promise<{ sha: string }>).catch(nullWhenMissing),
    ]);
    const checks = [
      ...checkRuns.check_runs.map((check) => ({
        name: check.name,
        outcome: checkOutcome({
          conclusion: check.conclusion,
          state: check.status === "completed" ? "COMPLETED" : "PENDING",
        }),
      })),
      ...combined.statuses.map((status) => ({
        name: status.context,
        outcome: checkOutcome({ state: status.state }),
      })),
    ];
    const failingChecks = checks.filter((check) => check.outcome === "failed")
      .map((check) => check.name);
    const pendingChecks = checks.filter((check) => check.outcome === "pending")
      .length;
    const unresolvedThreads =
      threads.review_threads.filter((thread) => !thread.is_resolved).length;
    const decisions = latestDecisions(reviews.map((review) => ({
      who: reviewer(review),
      state: review.state,
      commit: review.commit_id,
    })));

    return {
      approvals: approvalsOf(decisions),
      reviewDecision: reviewDecisionFrom(
        decisions,
        view.mergeable_state,
        failingChecks.length + pendingChecks > 0,
        unresolvedThreads > 0,
      ),
      failingChecks,
      pendingChecks,
      branchTip: branch?.sha ?? "",
      unresolvedThreads,
      isPartialRead: [
        reviews.length,
        threads.review_threads.length,
        checkRuns.check_runs.length,
      ].includes(commitsPerPage),
    };
  };

  const findMergeCommit = async (
    repo: string,
    view: McpPullRequest,
    mergedAt: string,
  ): Promise<string> => {
    const [owner, name] = repo.split("/");
    const commits = await client.call("list_commits", {
      owner,
      repo: name,
      sha: view.base.ref,
      since: shiftedIso(mergedAt, -mergeWindowMs),
      until: shiftedIso(mergedAt, mergeWindowMs),
      perPage: commitsPerPage,
    }) as McpCommit[];

    return mergeCommitIn(commits, view.number, view.head.sha);
  };

  const pullRequest = async (url: string): Promise<PullRequestFacts> => {
    const { repo, number } = parsePullRequestUrl(url);
    const view = await read(repo, number, "get") as McpPullRequest;
    const state = restState(view.state, view.merged);
    const mergedAt = view.merged_at ?? "";
    const details: OpenDetails = state === "OPEN"
      ? await openDetails(repo, view)
      : {
        approvals: [],
        reviewDecision: "NONE",
        failingChecks: [],
        pendingChecks: 0,
        branchTip: "",
        unresolvedThreads: 0,
        isPartialRead: false,
      };
    const branch = await defaultBranch(repo);
    const mergeSha = state === "MERGED"
      ? await findMergeCommit(repo, view, mergedAt).catch(nullWhenMissing) ?? ""
      : "";

    return {
      url: view.html_url,
      repo,
      number: view.number,
      title: view.title,
      author: view.user?.login ?? "",
      state,
      isDraft: view.draft,
      baseRef: view.base.ref,
      headRef: view.head.ref,
      headSha: view.head.sha,
      defaultBranch: branch,
      mergedAt,
      mergeSha,
      mergeable: mergeableFrom(view.mergeable_state),
      mergeStateStatus: view.mergeable_state.toUpperCase(),
      requestedReviewers: view.requested_reviewers ?? [],
      behindBy: 0,
      ...details,
    };
  };

  const pullRequestsForBranch = async (
    repo: string,
    branch: string,
  ): Promise<ParentCandidate[]> => {
    const [owner, name] = repo.split("/");
    const found = await client.call("list_pull_requests", {
      owner,
      repo: name,
      head: `${owner}:${branch}`,
      state: "all",
      perPage: 30,
      fields: ["number", "state", "merged_at", "html_url"],
    }) as {
      number: number;
      state: string;
      merged_at?: string | null;
      html_url: string;
    }[];

    return found.map((candidate) => ({
      url: candidate.html_url,
      number: candidate.number,
      state: restState(candidate.state, Boolean(candidate.merged_at)),
      mergedAt: candidate.merged_at ?? "",
    }));
  };

  const search = async (query: string, limit: number): Promise<string[]> => {
    const response = await client.call("search_pull_requests", {
      query,
      perPage: limit,
      fields: ["html_url"],
    }) as { items: { html_url: string }[] };

    return response.items.map((item) => item.html_url);
  };

  const latestWorkflowRun = async (
    repo: string,
    workflow: string,
    branch: string,
  ): Promise<DeployedRevision | null> => {
    const [owner, name] = repo.split("/");
    const response = await client.call("actions_list", {
      owner,
      repo: name,
      method: "list_workflow_runs",
      resource_id: workflow,
      perPage: 1,
      workflow_runs_filter: { branch, status: "success" },
    }) as { workflow_runs: { head_sha: string; updated_at: string }[] };
    const [latest] = response.workflow_runs;

    return latest ? { sha: latest.head_sha, at: latest.updated_at } : null;
  };

  const contains = async (
    repo: string,
    landedSha: string,
    landedAt: string,
    deployedSha: string,
  ): Promise<boolean | null> => {
    const [owner, name] = repo.split("/");

    for (let page = 1; page <= maxContainsPages; page++) {
      const commits = await client.call("list_commits", {
        owner,
        repo: name,
        sha: deployedSha,
        since: shiftedIso(landedAt, -landedSearchMarginMs),
        perPage: commitsPerPage,
        page,
        fields: ["sha"],
      }) as { sha: string }[];

      if (commits.some((commit) => commit.sha === landedSha)) return true;
      if (commits.length < commitsPerPage) return false;
    }

    return null;
  };

  const confirmedContains = async (
    repo: string,
    sha: string,
    at: string,
    branch: string,
  ): Promise<boolean> => {
    const isContained = await contains(repo, sha, at, branch)
      .catch(nullWhenMissing);

    if (isContained === null) {
      throw new Error(
        `Too many commits since ${
          sha.slice(0, 7)
        } to confirm it reached ${branch} over MCP. Use transport gh.`,
      );
    }

    return isContained;
  };

  const commitOnDefaultBranch = async (
    pr: PullRequestFacts,
  ): Promise<string> => {
    const [owner, name] = pr.repo.split("/");
    const isMergeCommitOn = pr.mergeSha !== "" &&
      await confirmedContains(
        pr.repo,
        pr.mergeSha,
        pr.mergedAt,
        pr.defaultBranch,
      );

    if (isMergeCommitOn) return pr.mergeSha;

    const head = await (client.call("get_commit", {
      owner,
      repo: name,
      sha: pr.headSha,
      detail: "none",
    }) as Promise<{ commit?: { committer?: { date?: string } } }>)
      .catch(nullWhenMissing);
    const committedAt = head?.commit?.committer?.date;

    if (!committedAt) return "";

    const isHeadOn = await confirmedContains(
      pr.repo,
      pr.headSha,
      committedAt,
      pr.defaultBranch,
    );

    return isHeadOn ? pr.headSha : "";
  };

  const commitDate = async (repo: string, sha: string): Promise<string> => {
    const [owner, name] = repo.split("/");
    const commit = await client.call("get_commit", {
      owner,
      repo: name,
      sha,
      detail: "none",
    }) as { commit: { committer: { date: string } } };

    return commit.commit.committer.date;
  };

  return {
    name: "mcp",
    pullRequest,
    pullRequestsForBranch,
    search,
    commitsSince: () => Promise.reject(unsupported("commit statuses")),
    latestDeployment: () => Promise.reject(unsupported("deployments")),
    latestWorkflowRun,
    commitOnDefaultBranch,
    commitDate,
    contains,
  };
}
