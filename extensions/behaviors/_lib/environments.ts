import type {
  CommitWithStatuses,
  DeployedRevision,
  EnvironmentConfig,
  EnvironmentResult,
  GitHubSource,
} from "./types.ts";

export type LandedCommit = {
  repo: string;
  defaultBranch: string;
  sha: string;
  at: string;
};

const commitDateMarginMs = 10 * 60_000;
const failedStates = ["FAILURE", "ERROR"];
const maxDeploysToConfirm = 10;

function unknown(name: string, detail: string): EnvironmentResult {
  return { name, state: "unknown", at: "", detail };
}

function newestUpdate(times: string[]): string {
  return [...times].sort().at(-1) ?? "";
}

function matchingStatuses(commit: CommitWithStatuses, statusName: string) {
  return commit.statuses.filter((status) =>
    status.context.includes(statusName)
  );
}

export async function environmentFromStatuses(
  name: string,
  newestFirstCommits: CommitWithStatuses[],
  statusName: string,
  landedSha: string,
  isContainedIn: (sha: string) => Promise<boolean | null>,
): Promise<EnvironmentResult> {
  const oldestFirst = [...newestFirstCommits].reverse();
  const landedIndex = oldestFirst.findIndex((commit) =>
    commit.sha === landedSha
  );

  if (landedIndex === -1) {
    return unknown(
      name,
      "too many commits have landed since to walk back to it.",
    );
  }

  const withStatus = oldestFirst.slice(landedIndex)
    .map((commit) => ({
      sha: commit.sha,
      statuses: matchingStatuses(commit, statusName),
    }))
    .filter((commit) => commit.statuses.length > 0);
  const allSuccesses = withStatus.filter((commit) =>
    commit.statuses.every((status) => status.state === "SUCCESS")
  );
  const isContained = async (sha: string): Promise<boolean | null> =>
    sha === landedSha || await isContainedIn(sha);

  for (const success of allSuccesses.slice(0, maxDeploysToConfirm)) {
    if (await isContained(success.sha)) {
      return {
        name,
        state: "deployed",
        at: newestUpdate(success.statuses.map((status) => status.updatedAt)),
        detail: "",
      };
    }
  }

  if (allSuccesses.length > maxDeploysToConfirm) {
    return unknown(name, "too many deploys to confirm which one contains it.");
  }

  const newest = withStatus.at(-1);

  if (!newest) {
    return unknown(
      name,
      `no "${statusName}" status on this commit or any later one.`,
    );
  }

  const isNewestContained = await isContained(newest.sha);

  if (isNewestContained === null) {
    return unknown(name, "too many commits to confirm it's in that deploy.");
  }

  if (!isNewestContained || allSuccesses.includes(newest)) {
    return { name, state: "not-yet", at: "", detail: "" };
  }

  const failed = newest.statuses.find((status) =>
    failedStates.includes(status.state)
  );

  if (failed) {
    return { name, state: "failed", at: "", detail: failed.context };
  }

  return { name, state: "deploying", at: "", detail: "" };
}

async function environmentFromRevision(
  name: string,
  source: GitHubSource,
  landed: LandedCommit,
  revision: DeployedRevision | null,
  missing: string,
): Promise<EnvironmentResult> {
  if (!revision) return unknown(name, missing);

  const isContained = revision.sha === landed.sha ||
    await source.contains(landed.repo, landed.sha, landed.at, revision.sha);

  if (isContained === null) {
    return unknown(name, "too many commits to confirm it's in that deploy.");
  }

  if (!isContained) return { name, state: "not-yet", at: "", detail: "" };

  return { name, state: "deployed", at: revision.at, detail: "" };
}

function searchStart(landedAt: string): string {
  return new Date(Date.parse(landedAt) - commitDateMarginMs).toISOString();
}

async function readEnvironment(
  source: GitHubSource,
  config: EnvironmentConfig,
  landed: LandedCommit,
): Promise<EnvironmentResult> {
  const { name, commitStatus, githubDeployment, githubActionsWorkflow } =
    config;

  if (commitStatus) {
    const commits = await source.commitsSince(
      landed.repo,
      landed.defaultBranch,
      searchStart(landed.at),
      landed.sha,
    );

    return environmentFromStatuses(
      name,
      commits,
      commitStatus,
      landed.sha,
      (sha) => source.contains(landed.repo, landed.sha, landed.at, sha),
    );
  }

  if (githubDeployment) {
    const revision = await source.latestDeployment(
      landed.repo,
      githubDeployment,
    );

    return environmentFromRevision(
      name,
      source,
      landed,
      revision,
      `no successful "${githubDeployment}" deployment found.`,
    );
  }

  const revision = await source.latestWorkflowRun(
    landed.repo,
    githubActionsWorkflow ?? "",
    landed.defaultBranch,
  );

  return environmentFromRevision(
    name,
    source,
    landed,
    revision,
    `no successful run of ${githubActionsWorkflow} found.`,
  );
}

export function readEnvironments(
  source: GitHubSource,
  configs: EnvironmentConfig[],
  landed: LandedCommit,
): Promise<EnvironmentResult[]> {
  return Promise.all(configs.map(async (config) => {
    if (!landed.sha) {
      return unknown(config.name, "couldn't find its merge commit.");
    }

    try {
      return await readEnvironment(source, config, landed);
    } catch (error) {
      return unknown(config.name, (error as Error).message);
    }
  }));
}
