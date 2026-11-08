export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

export type Approval = { who: string; commit: string };

export type PullRequestFacts = {
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PullRequestState;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  defaultBranch: string;
  mergedAt: string;
  mergeSha: string;
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  approvals: Approval[];
  requestedReviewers: string[];
  failingChecks: string[];
  pendingChecks: number;
  behindBy: number;
  branchTip: string;
  unresolvedThreads: number;
  isPartialRead: boolean;
};

export type ParentCandidate = {
  url: string;
  number: number;
  state: PullRequestState;
  mergedAt: string;
};

export type CommitStatus = {
  context: string;
  state: string;
  updatedAt: string;
};

export type CommitWithStatuses = {
  sha: string;
  statuses: CommitStatus[];
};

export type DeployedRevision = {
  sha: string;
  at: string;
};

export type GitHubSource = {
  name: string;
  pullRequest: (url: string) => Promise<PullRequestFacts>;
  pullRequestsForBranch: (
    repo: string,
    branch: string,
  ) => Promise<ParentCandidate[]>;
  search: (query: string, limit: number) => Promise<string[]>;
  commitsSince: (
    repo: string,
    branch: string,
    since: string,
    stopAtSha: string,
  ) => Promise<CommitWithStatuses[]>;
  latestDeployment: (
    repo: string,
    environment: string,
  ) => Promise<DeployedRevision | null>;
  latestWorkflowRun: (
    repo: string,
    workflow: string,
    branch: string,
  ) => Promise<DeployedRevision | null>;
  commitOnDefaultBranch: (pullRequest: PullRequestFacts) => Promise<string>;
  commitDate: (repo: string, sha: string) => Promise<string>;
  contains: (
    repo: string,
    landedSha: string,
    landedAt: string,
    deployedSha: string,
  ) => Promise<boolean | null>;
};

export type EnvironmentConfig = {
  name: string;
  commitStatus?: string;
  githubDeployment?: string;
  githubActionsWorkflow?: string;
};

export type EnvironmentState =
  | "deployed"
  | "deploying"
  | "failed"
  | "not-yet"
  | "unknown";

export type EnvironmentResult = {
  name: string;
  state: EnvironmentState;
  at: string;
  detail: string;
};

export type Blocker = { kind: string; text: string };

export type PullRequestDelivery = {
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PullRequestState;
  isDraft: boolean;
  stage: string;
  where: string;
  blockedBy: { url: string; label: string } | null;
  blockers: Blocker[];
  mergedAt: string;
  landedSha: string;
  isPartialRead: boolean;
  environments: EnvironmentResult[];
  source: string;
  checkedAt: string;
};
