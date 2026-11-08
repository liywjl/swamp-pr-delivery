import type {
  Approval,
  Blocker,
  EnvironmentResult,
  ParentCandidate,
  PullRequestDelivery,
  PullRequestFacts,
} from "./types.ts";

export type Landing =
  | { kind: "closed" }
  | { kind: "open"; pullRequest: PullRequestFacts }
  | { kind: "stranded"; reason: string }
  | { kind: "landed"; sha: string; at: string };

export type ParentLookup = (
  pullRequest: PullRequestFacts,
) => PullRequestFacts | null;

function newestFirst(candidates: ParentCandidate[]): ParentCandidate[] {
  return [...candidates].sort((left, right) => right.number - left.number);
}

function earliestMergedAfter(
  merged: ParentCandidate[],
  mergedAt: string,
): ParentCandidate | null {
  const after = merged.filter((candidate) => candidate.mergedAt >= mergedAt);
  const earliestFirst = [...after].sort((left, right) =>
    left.mergedAt.localeCompare(right.mergedAt)
  );

  return earliestFirst[0] ?? null;
}

export function chooseParent(
  candidates: ParentCandidate[],
  child: PullRequestFacts,
): ParentCandidate | null {
  const others = newestFirst(candidates).filter((candidate) =>
    candidate.url !== child.url
  );
  const merged = others.filter((candidate) => candidate.state === "MERGED");
  const landedChild = earliestMergedAfter(merged, child.mergedAt);

  if (landedChild) return landedChild;

  const open = others.find((candidate) => candidate.state === "OPEN");

  return open ?? merged[0] ?? others[0] ?? null;
}

export function pullRequestLabel(
  pullRequest: { repo: string; number: number },
): string {
  return `${pullRequest.repo.split("/")[1]}#${pullRequest.number}`;
}

export function landingOf(
  pullRequest: PullRequestFacts,
  parentOf: ParentLookup,
): Landing {
  if (pullRequest.state === "CLOSED") return { kind: "closed" };
  if (pullRequest.state === "OPEN") return { kind: "open", pullRequest };

  if (pullRequest.baseRef === pullRequest.defaultBranch) {
    return {
      kind: "landed",
      sha: pullRequest.mergeSha,
      at: pullRequest.mergedAt,
    };
  }

  const parent = parentOf(pullRequest);
  const { baseRef, defaultBranch } = pullRequest;

  if (!parent) {
    return {
      kind: "stranded",
      reason:
        `Merged into ${baseRef}, and no PR takes that branch to ${defaultBranch}.`,
    };
  }

  if (parent.state === "CLOSED") {
    return {
      kind: "stranded",
      reason: `Merged into ${baseRef}, but ${
        pullRequestLabel(parent)
      } closed without merging.`,
    };
  }

  const mergedAfterParentLanded = parent.state === "MERGED" &&
    parent.mergedAt < pullRequest.mergedAt;

  if (mergedAfterParentLanded) {
    return {
      kind: "stranded",
      reason: `Merged into ${baseRef} after ${
        pullRequestLabel(parent)
      } had already landed, and its commits aren't on ${defaultBranch}.`,
    };
  }

  return landingOf(parent, parentOf);
}

function namesOf(approvals: Approval[]): string {
  return [...new Set(approvals.map((approval) => approval.who))].join(", ");
}

function reviewBlocker(pullRequest: PullRequestFacts): Blocker | null {
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
    return { kind: "changes-requested", text: "A reviewer asked for changes." };
  }

  if (pullRequest.reviewDecision !== "REVIEW_REQUIRED") return null;

  const { approvals, headSha, requestedReviewers } = pullRequest;
  const stillRequested = requestedReviewers.length > 0
    ? ` Still requested: ${requestedReviewers.join(", ")}.`
    : "";
  const onHead = approvals.filter((approval) => approval.commit === headSha);

  if (approvals.length === 0) {
    return {
      kind: "needs-review",
      text: `Nobody has approved it.${stillRequested}`,
    };
  }

  if (onHead.length === 0) {
    return {
      kind: "approval-outdated",
      text: `${
        namesOf(approvals)
      } approved an earlier commit, and GitHub still wants a review.${stillRequested}`,
    };
  }

  return {
    kind: "approval-not-enough",
    text: `${
      namesOf(onHead)
    } approved, but GitHub doesn't count that as enough.${stillRequested}`,
  };
}

function checksBlocker(pullRequest: PullRequestFacts): Blocker | null {
  const { failingChecks, pendingChecks, behindBy, baseRef } = pullRequest;

  if (failingChecks.length > 0) {
    const staleHint = behindBy > 0
      ? ` The branch is ${behindBy} commits behind ${baseRef}, so the fix may already be there: update the branch first.`
      : "";

    return {
      kind: "checks-failing",
      text: `${failingChecks.slice(0, 3).join(", ")} failing.${staleHint}`,
    };
  }

  if (pendingChecks > 0) {
    return {
      kind: "checks-running",
      text: `${pendingChecks} checks still running.`,
    };
  }

  return null;
}

function syncBlocker(pullRequest: PullRequestFacts): Blocker | null {
  const { branchTip, headSha, mergeable, baseRef } = pullRequest;
  const isOutOfSync = branchTip !== "" && branchTip !== headSha;

  if (isOutOfSync) {
    return {
      kind: "out-of-sync",
      text: `The PR still points at ${
        headSha.slice(0, 7)
      }, but the branch is at ${
        branchTip.slice(0, 7)
      }. GitHub missed the push, so CI and the merge button are looking at the old commit. A new push fixes it.`,
    };
  }

  if (mergeable === "CONFLICTING") {
    return { kind: "conflicts", text: `It conflicts with ${baseRef}.` };
  }

  if (mergeable === "UNKNOWN") {
    return {
      kind: "merge-check-stuck",
      text:
        "GitHub hasn't worked out whether it can merge. A new push usually restarts that check.",
    };
  }

  return null;
}

function incidentBlocker(incidents: string[]): Blocker | null {
  if (incidents.length === 0) return null;

  return {
    kind: "github-incident",
    text: `GitHub is having problems: ${
      incidents.join(", ")
    }. Don't chase failures until it clears.`,
  };
}

function draftBlocker(pullRequest: PullRequestFacts): Blocker | null {
  return pullRequest.isDraft ? { kind: "draft", text: "It's a draft." } : null;
}

function threadsBlocker(pullRequest: PullRequestFacts): Blocker | null {
  if (pullRequest.unresolvedThreads === 0) return null;

  return {
    kind: "unresolved-threads",
    text: `${pullRequest.unresolvedThreads} unresolved review threads.`,
  };
}

function behindBlocker(pullRequest: PullRequestFacts): Blocker | null {
  const isOnlyBehind = pullRequest.mergeStateStatus === "BEHIND" &&
    pullRequest.failingChecks.length === 0;

  if (!isOnlyBehind) return null;

  return {
    kind: "behind",
    text:
      `Branch is behind ${pullRequest.baseRef}, and this repo requires it to be up to date.`,
  };
}

export function mergeBlockers(
  pullRequest: PullRequestFacts,
  incidents: string[],
): Blocker[] {
  const candidates = [
    incidentBlocker(incidents),
    syncBlocker(pullRequest),
    draftBlocker(pullRequest),
    checksBlocker(pullRequest),
    reviewBlocker(pullRequest),
    threadsBlocker(pullRequest),
    behindBlocker(pullRequest),
  ];

  return candidates.filter((blocker): blocker is Blocker => blocker !== null);
}

function furthestDeployed(
  environments: EnvironmentResult[],
): EnvironmentResult | null {
  const deployed = environments.filter((environment) =>
    environment.state === "deployed"
  );

  return deployed.at(-1) ?? null;
}

export function landedStage(environments: EnvironmentResult[]): string {
  const furthest = furthestDeployed(environments);

  return furthest ? `on-${furthest.name}` : "on-default-branch";
}

function environmentSentence(environment: EnvironmentResult): string {
  const { name, state, detail } = environment;

  if (state === "failed") return `The ${name} deploy failed: ${detail}.`;
  if (state === "deploying") return `The ${name} deploy is still running.`;
  if (state === "not-yet") return `Not on ${name} yet.`;

  return `Can't tell if it's on ${name}: ${detail}`;
}

function landedWhere(
  defaultBranch: string,
  environments: EnvironmentResult[],
): string {
  if (environments.length === 0) return `On ${defaultBranch}.`;

  const furthest = furthestDeployed(environments);
  const beyondIndex = furthest ? environments.indexOf(furthest) + 1 : 0;
  const opening = furthest ? `On ${furthest.name}.` : `On ${defaultBranch}.`;
  const remaining = environments.slice(beyondIndex).map(environmentSentence);

  return [opening, ...remaining].join(" ");
}

export function deliveryOf(
  pullRequest: PullRequestFacts,
  parentOf: ParentLookup,
  environments: EnvironmentResult[],
  incidents: string[],
  provenance: { source: string; checkedAt: string },
): PullRequestDelivery {
  const landing = landingOf(pullRequest, parentOf);
  const base = {
    url: pullRequest.url,
    repo: pullRequest.repo,
    number: pullRequest.number,
    title: pullRequest.title,
    author: pullRequest.author,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergedAt: pullRequest.mergedAt,
    blockedBy: null,
    blockers: [],
    landedSha: "",
    isPartialRead: pullRequest.isPartialRead,
    environments: [],
    ...provenance,
  };

  if (landing.kind === "closed") {
    return { ...base, stage: "closed", where: "Closed without merging." };
  }

  if (landing.kind === "stranded") {
    return { ...base, stage: "stranded", where: landing.reason };
  }

  if (landing.kind === "open") {
    const blockers = mergeBlockers(landing.pullRequest, incidents);
    const isThisPullRequest = landing.pullRequest.url === pullRequest.url;

    if (isThisPullRequest) {
      return {
        ...base,
        stage: "in-review",
        where: `Open, not merged into ${pullRequest.baseRef}.`,
        blockers,
      };
    }

    const label = pullRequestLabel(landing.pullRequest);

    return {
      ...base,
      stage: "merged-into-branch",
      where:
        `Merged into ${pullRequest.baseRef}, not ${pullRequest.defaultBranch}. ${label} has to land first.`,
      blockedBy: { url: landing.pullRequest.url, label },
      isPartialRead: landing.pullRequest.isPartialRead,
      blockers,
    };
  }

  return {
    ...base,
    stage: landedStage(environments),
    where: landedWhere(pullRequest.defaultBranch, environments),
    landedSha: landing.sha,
    environments,
  };
}
