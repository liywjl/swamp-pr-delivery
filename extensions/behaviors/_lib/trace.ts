import { chooseParent, deliveryOf, landingOf } from "./delivery.ts";
import { readEnvironments } from "./environments.ts";
import type {
  EnvironmentConfig,
  EnvironmentResult,
  GitHubSource,
  PullRequestDelivery,
  PullRequestFacts,
} from "./types.ts";

const maxStackDepth = 20;
const gitHubStatusUrl = "https://www.githubstatus.com/api/v2/summary.json";
const relevantGitHubComponents =
  /pull requests|git operations|actions|webhooks|api requests/i;

function isMergedIntoBranch(pullRequest: PullRequestFacts): boolean {
  return pullRequest.state === "MERGED" &&
    pullRequest.baseRef !== pullRequest.defaultBranch;
}

function needsLandingProof(pullRequest: PullRequestFacts): boolean {
  const isMissingMergeCommit = pullRequest.state === "MERGED" &&
    pullRequest.mergeSha === "";

  return isMergedIntoBranch(pullRequest) || isMissingMergeCommit;
}

async function withProvenLanding(
  source: GitHubSource,
  pullRequest: PullRequestFacts,
): Promise<PullRequestFacts> {
  if (!needsLandingProof(pullRequest)) return pullRequest;

  const sha = await source.commitOnDefaultBranch(pullRequest);

  if (!sha) return pullRequest;

  return { ...pullRequest, baseRef: pullRequest.defaultBranch, mergeSha: sha };
}

async function parentsOf(
  source: GitHubSource,
  pullRequest: PullRequestFacts,
): Promise<Map<string, PullRequestFacts>> {
  const parents = new Map<string, PullRequestFacts>();
  let current = pullRequest;

  for (let depth = 0; depth < maxStackDepth; depth++) {
    if (!isMergedIntoBranch(current)) return parents;

    const candidates = await source.pullRequestsForBranch(
      current.repo,
      current.baseRef,
    );
    const chosen = chooseParent(candidates, current);

    if (!chosen) return parents;

    const parent = await withProvenLanding(
      source,
      await source.pullRequest(chosen.url),
    );

    parents.set(current.url, parent);
    current = parent;
  }

  throw new Error(
    `${pullRequest.url} is stacked more than ${maxStackDepth} deep.`,
  );
}

async function environmentsOf(
  source: GitHubSource,
  configs: EnvironmentConfig[],
  pullRequest: PullRequestFacts,
  landing: { sha: string; at: string },
): Promise<EnvironmentResult[]> {
  if (configs.length === 0) return [];

  const landed = {
    repo: pullRequest.repo,
    defaultBranch: pullRequest.defaultBranch,
    sha: landing.sha,
    at: landing.at,
  };

  if (!landing.sha) return readEnvironments(source, configs, landed);

  try {
    const at = await source.commitDate(pullRequest.repo, landing.sha);

    return readEnvironments(source, configs, { ...landed, at });
  } catch {
    return configs.map((config) => ({
      name: config.name,
      state: "unknown" as const,
      at: "",
      detail: "couldn't read the date of the commit it landed on.",
    }));
  }
}

export async function tracePullRequest(
  source: GitHubSource,
  url: string,
  configs: EnvironmentConfig[],
  incidents: string[],
  now: () => Date = () => new Date(),
): Promise<PullRequestDelivery> {
  const pullRequest = await withProvenLanding(
    source,
    await source.pullRequest(url),
  );
  const parents = await parentsOf(source, pullRequest);
  const parentOf = (candidate: PullRequestFacts) =>
    parents.get(candidate.url) ?? null;
  const landing = landingOf(pullRequest, parentOf);
  const environments = landing.kind === "landed"
    ? await environmentsOf(source, configs, pullRequest, landing)
    : [];

  return deliveryOf(pullRequest, parentOf, environments, incidents, {
    source: source.name,
    checkedAt: now().toISOString(),
  });
}

export async function activeGitHubIncidents(
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const response = await fetcher(gitHubStatusUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return [];

    const summary = await response.json() as {
      components: { name: string; status: string }[];
    };

    return summary.components
      .filter((component) =>
        component.status !== "operational" &&
        relevantGitHubComponents.test(component.name)
      )
      .map((component) => component.name);
  } catch {
    return [];
  }
}

export function dataNameOf(delivery: { repo: string; number: number }): string {
  return `${delivery.repo.replace("/", "--")}-${delivery.number}`;
}
