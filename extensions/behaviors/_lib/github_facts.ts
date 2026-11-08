import type { Approval, PullRequestState } from "./types.ts";

export type Review = { who: string; state: string; commit: string };

export type CheckOutcome = "passed" | "failed" | "pending";

const passedOutcomes = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const failedOutcomes = [
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];

export function checkOutcome(
  check: { conclusion?: string | null; state?: string | null },
): CheckOutcome {
  const outcome = (check.conclusion || check.state || "PENDING").toUpperCase();

  if (passedOutcomes.includes(outcome)) return "passed";
  if (failedOutcomes.includes(outcome)) return "failed";

  return "pending";
}

export function latestDecisions(reviews: Review[]): Review[] {
  const latestByPerson = new Map<string, Review>();

  for (const review of reviews) {
    const isDecision = review.state !== "COMMENTED" &&
      review.state !== "PENDING";

    if (isDecision) latestByPerson.set(review.who, review);
  }

  return [...latestByPerson.values()];
}

export function approvalsOf(decisions: Review[]): Approval[] {
  return decisions
    .filter((review) => review.state === "APPROVED")
    .map((review) => ({ who: review.who, commit: review.commit }));
}

export function parsePullRequestUrl(
  url: string,
): { repo: string; number: number } {
  const match = url.match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );

  if (!match) throw new Error(`Not a GitHub pull request URL: ${url}`);

  return { repo: match[1], number: Number(match[2]) };
}

export function restState(
  state: string,
  isMerged: boolean,
): PullRequestState {
  if (isMerged) return "MERGED";

  return state.toLowerCase() === "open" ? "OPEN" : "CLOSED";
}

export function isMissingOnGitHub(error: unknown): boolean {
  return /HTTP 404|404 Not Found|No commit found/i.test(
    (error as Error).message,
  );
}

export function nullWhenMissing(error: unknown): null {
  if (isMissingOnGitHub(error)) return null;

  throw error;
}
