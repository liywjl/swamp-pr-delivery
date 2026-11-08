import {
  approvalsOf,
  checkOutcome,
  isMissingOnGitHub,
  latestDecisions,
  nullWhenMissing,
  parsePullRequestUrl,
  restState,
} from "./github_facts.ts";
import type {
  CommitWithStatuses,
  DeployedRevision,
  GitHubSource,
  ParentCandidate,
  PullRequestFacts,
  PullRequestState,
} from "./types.ts";

export type GhRunner = (args: string[]) => Promise<unknown>;

type PullRequestView = {
  url: string;
  number: number;
  title: string;
  state: PullRequestState;
  isDraft: boolean;
  isCrossRepository: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewRequests: { login?: string; name?: string; slug?: string }[];
  statusCheckRollup: {
    name?: string;
    context?: string;
    conclusion?: string | null;
    state?: string | null;
  }[];
  author?: { login: string } | null;
};

type RestReview = {
  user: { login: string } | null;
  state: string;
  commit_id: string;
};

type HistoryPage = {
  data: {
    repository: {
      ref: {
        target: {
          history: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: {
              oid: string;
              status: {
                contexts: {
                  context: string;
                  state: string;
                  createdAt: string;
                }[];
              } | null;
            }[];
          };
        };
      } | null;
    };
  };
};

type Deployment = { id: number; sha: string };

type DeploymentStatus = { state: string; created_at: string };

const viewFields = [
  "url",
  "number",
  "title",
  "author",
  "state",
  "isDraft",
  "isCrossRepository",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergedAt",
  "mergeCommit",
  "reviewDecision",
  "mergeable",
  "mergeStateStatus",
  "reviewRequests",
  "statusCheckRollup",
].join(",");

const unresolvedThreadsQuery =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";

const historyQuery =
  "query($owner:String!,$name:String!,$ref:String!,$since:GitTimestamp!,$cursor:String){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{... on Commit{history(first:100,since:$since,after:$cursor){pageInfo{hasNextPage endCursor}nodes{oid status{contexts{context state createdAt}}}}}}}}}";

const maxHistoryPages = 5;
const maxDeploymentsToCheck = 10;
const pageSize = 100;
const ghTimeoutMs = 60_000;

export async function runGh(args: string[]): Promise<unknown> {
  const output = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(ghTimeoutMs),
  })
    .output();

  if (!output.success) {
    throw new Error(
      `gh failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }

  return JSON.parse(new TextDecoder().decode(output.stdout));
}

export function createGhSource(run: GhRunner): GitHubSource {
  const defaultBranches = new Map<string, Promise<string>>();

  const defaultBranch = (repo: string): Promise<string> => {
    const known = defaultBranches.get(repo);

    if (known) return known;

    const branch =
      (run(["api", `repos/${repo}`]) as Promise<{ default_branch: string }>)
        .then((response) => response.default_branch);

    defaultBranches.set(repo, branch);

    return branch;
  };

  const unresolvedThreads = async (
    repo: string,
    number: number,
  ): Promise<{ unresolved: number; total: number }> => {
    const [owner, name] = repo.split("/");
    const response = await run([
      "api",
      "graphql",
      "-f",
      `query=${unresolvedThreadsQuery}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]) as {
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } };
        };
      };
    };
    const threads = response.data.repository.pullRequest.reviewThreads.nodes;

    return {
      unresolved: threads.filter((thread) => !thread.isResolved).length,
      total: threads.length,
    };
  };

  const openDetails = async (repo: string, view: PullRequestView) => {
    const head = encodeURIComponent(view.headRefName);
    const base = encodeURIComponent(view.baseRefName);
    const [reviews, branch, comparison, threads] = await Promise.all([
      run([
        "api",
        `repos/${repo}/pulls/${view.number}/reviews?per_page=100`,
      ]) as Promise<RestReview[]>,
      view.isCrossRepository
        ? null
        : (run(["api", `repos/${repo}/branches/${head}`]) as Promise<
          { commit: { sha: string } }
        >)
          .catch(nullWhenMissing),
      (run(["api", `repos/${repo}/compare/${base}...${head}`]) as Promise<
        { behind_by: number }
      >)
        .catch(nullWhenMissing),
      unresolvedThreads(repo, view.number),
    ]);
    const decisions = latestDecisions(
      reviews.filter((review) => review.user).map((review) => ({
        who: review.user?.login ?? "",
        state: review.state,
        commit: review.commit_id,
      })),
    );

    return {
      approvals: approvalsOf(decisions),
      branchTip: branch?.commit.sha ?? "",
      behindBy: comparison?.behind_by ?? 0,
      unresolvedThreads: threads.unresolved,
      isPartialRead: reviews.length === pageSize ||
        threads.total === pageSize,
    };
  };

  const pullRequest = async (url: string): Promise<PullRequestFacts> => {
    const { repo } = parsePullRequestUrl(url);
    const view = await run([
      "pr",
      "view",
      url,
      "--json",
      viewFields,
    ]) as PullRequestView;
    const outcomes = view.statusCheckRollup.map((check) => ({
      name: check.name ?? check.context ?? "check",
      outcome: checkOutcome(check),
    }));
    const details = view.state === "OPEN" ? await openDetails(repo, view) : {
      approvals: [],
      branchTip: "",
      behindBy: 0,
      unresolvedThreads: 0,
      isPartialRead: false,
    };

    return {
      url: view.url,
      repo,
      number: view.number,
      title: view.title,
      author: view.author?.login ?? "",
      state: view.state,
      isDraft: view.isDraft,
      baseRef: view.baseRefName,
      headRef: view.headRefName,
      headSha: view.headRefOid,
      defaultBranch: await defaultBranch(repo),
      mergedAt: view.mergedAt ?? "",
      mergeSha: view.mergeCommit?.oid ?? "",
      reviewDecision: view.reviewDecision || "NONE",
      mergeable: view.mergeable,
      mergeStateStatus: view.mergeStateStatus,
      requestedReviewers: view.reviewRequests.map((request) =>
        request.login ?? request.slug ?? request.name ?? "team"
      ),
      failingChecks: outcomes.filter((check) => check.outcome === "failed").map(
        (check) => check.name,
      ),
      pendingChecks:
        outcomes.filter((check) => check.outcome === "pending").length,
      ...details,
    };
  };

  const pullRequestsForBranch = async (
    repo: string,
    branch: string,
  ): Promise<ParentCandidate[]> => {
    const owner = repo.split("/")[0];
    const head = encodeURIComponent(`${owner}:${branch}`);
    const found = await run([
      "api",
      `repos/${repo}/pulls?head=${head}&state=all&per_page=${pageSize}`,
    ]) as {
      html_url: string;
      number: number;
      state: string;
      merged_at: string | null;
    }[];

    return found.map((candidate) => ({
      url: candidate.html_url,
      number: candidate.number,
      state: restState(candidate.state, Boolean(candidate.merged_at)),
      mergedAt: candidate.merged_at ?? "",
    }));
  };

  const search = async (query: string, limit: number): Promise<string[]> => {
    const terms = query.split(/\s+/).filter(Boolean);
    const found = await run([
      "search",
      "prs",
      "--limit",
      String(limit),
      "--json",
      "url",
      "--",
      ...terms,
    ]) as { url: string }[];

    return found.map((result) => result.url);
  };

  const commitsSince = async (
    repo: string,
    branch: string,
    since: string,
    stopAtSha: string,
  ): Promise<CommitWithStatuses[]> => {
    const [owner, name] = repo.split("/");
    const commits: CommitWithStatuses[] = [];
    let cursor = "";

    for (let page = 0; page < maxHistoryPages; page++) {
      const cursorArgs = cursor ? ["-f", `cursor=${cursor}`] : [];
      const response = await run([
        "api",
        "graphql",
        "-f",
        `query=${historyQuery}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `ref=refs/heads/${branch}`,
        "-f",
        `since=${since}`,
        ...cursorArgs,
      ]) as HistoryPage;
      const history = response.data.repository.ref?.target.history;

      if (!history) return commits;

      commits.push(...history.nodes.map((node) => ({
        sha: node.oid,
        statuses: (node.status?.contexts ?? []).map((status) => ({
          context: status.context,
          state: status.state,
          updatedAt: status.createdAt,
        })),
      })));

      const hasReachedLanded = history.nodes.some((node) =>
        node.oid === stopAtSha
      );

      if (hasReachedLanded || !history.pageInfo.hasNextPage) return commits;

      cursor = history.pageInfo.endCursor;
    }

    return commits;
  };

  const latestDeployment = async (
    repo: string,
    environment: string,
  ): Promise<DeployedRevision | null> => {
    const deployments = await run([
      "api",
      `repos/${repo}/deployments?environment=${
        encodeURIComponent(environment)
      }&per_page=${maxDeploymentsToCheck}`,
    ]) as Deployment[];

    for (const deployment of deployments) {
      const statuses = await run([
        "api",
        `repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
      ]) as DeploymentStatus[];
      const [latest] = statuses;

      if (latest?.state === "success") {
        return { sha: deployment.sha, at: latest.created_at };
      }
    }

    return null;
  };

  const latestWorkflowRun = async (
    repo: string,
    workflow: string,
    branch: string,
  ): Promise<DeployedRevision | null> => {
    const response = await run([
      "api",
      `repos/${repo}/actions/workflows/${
        encodeURIComponent(workflow)
      }/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=1`,
    ]) as { workflow_runs: { head_sha: string; updated_at: string }[] };
    const [run_] = response.workflow_runs;

    return run_ ? { sha: run_.head_sha, at: run_.updated_at } : null;
  };

  const contains = async (
    repo: string,
    landedSha: string,
    _landedAt: string,
    deployedSha: string,
  ): Promise<boolean> => {
    const comparison = await run([
      "api",
      `repos/${repo}/compare/${landedSha}...${deployedSha}`,
    ]) as { status: string };

    return ["ahead", "identical"].includes(comparison.status);
  };

  const commitOnDefaultBranch = async (
    pr: PullRequestFacts,
  ): Promise<string> => {
    for (const sha of [pr.mergeSha, pr.headSha].filter(Boolean)) {
      const isOnDefaultBranch = await contains(
        pr.repo,
        sha,
        pr.mergedAt,
        pr.defaultBranch,
      ).catch((error) => {
        if (isMissingOnGitHub(error)) return false;

        throw error;
      });

      if (isOnDefaultBranch) return sha;
    }

    return "";
  };

  const commitDate = async (repo: string, sha: string): Promise<string> => {
    const commit = await run(["api", `repos/${repo}/commits/${sha}`]) as {
      commit: { committer: { date: string } };
    };

    return commit.commit.committer.date;
  };

  return {
    name: "gh",
    pullRequest,
    pullRequestsForBranch,
    search,
    commitsSince,
    latestDeployment,
    latestWorkflowRun,
    commitOnDefaultBranch,
    commitDate,
    contains,
  };
}
