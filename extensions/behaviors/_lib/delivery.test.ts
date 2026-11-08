import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { chooseParent, deliveryOf, landingOf, mergeBlockers } from "./delivery.ts";
import { pullRequestFacts } from "./fixtures.ts";
import type { EnvironmentResult, ParentCandidate } from "./types.ts";

const provenance = { source: "fake", checkedAt: "2026-11-08T12:00:00Z" };
const noParent = () => null;
const kindsOf = (blockers: { kind: string }[]) => blockers.map((blocker) => blocker.kind);

function candidate(number: number, state: ParentCandidate["state"], mergedAt = ""): ParentCandidate {
  return { url: `https://github.com/acme/shop/pull/${number}`, number, state, mergedAt };
}

Deno.test("a PR merged into a branch with no PR to the default branch is stranded", () => {
  const child = pullRequestFacts({ state: "MERGED", baseRef: "feature", mergedAt: "2026-11-01T10:00:00Z" });

  assertEquals(landingOf(child, noParent).kind, "stranded");
});

Deno.test("a PR merged into a branch after that branch landed is stranded", () => {
  const parent = pullRequestFacts({ number: 11, state: "MERGED", mergedAt: "2026-11-01T09:00:00Z", mergeSha: "b1" });
  const child = pullRequestFacts({ state: "MERGED", baseRef: "feature", mergedAt: "2026-11-01T10:00:00Z" });
  const delivery = deliveryOf(child, () => parent, [], [], provenance);

  assertEquals(delivery.stage, "stranded");
  assertEquals(delivery.where, "Merged into feature after shop#11 had already landed, and its commits aren't on main.");
});

Deno.test("a PR whose parent closed without merging is stranded", () => {
  const parent = pullRequestFacts({ number: 11, state: "CLOSED" });
  const child = pullRequestFacts({ state: "MERGED", baseRef: "feature", mergedAt: "2026-11-01T10:00:00Z" });

  assertEquals(deliveryOf(child, () => parent, [], [], provenance).stage, "stranded");
});

Deno.test("a chain of stacked PRs is followed to the one still open", () => {
  const root = pullRequestFacts({ number: 10, failingChecks: ["unit"] });
  const middle = pullRequestFacts({ number: 11, state: "MERGED", baseRef: "root", mergedAt: "2026-11-01T11:00:00Z" });
  const top = pullRequestFacts({ state: "MERGED", baseRef: "middle", mergedAt: "2026-11-01T10:00:00Z" });
  const parentOf = (pullRequest: { number: number }) => pullRequest.number === 12 ? middle : root;
  const delivery = deliveryOf(top, parentOf as never, [], [], provenance);

  assertEquals(delivery.stage, "merged-into-branch");
  assertEquals(delivery.blockedBy?.label, "shop#10");
  assertEquals(kindsOf(delivery.blockers), ["checks-failing"]);
});

Deno.test("a stacked PR lands on the commit its parent landed on", () => {
  const parent = pullRequestFacts({ number: 11, state: "MERGED", mergedAt: "2026-11-01T11:00:00Z", mergeSha: "parent-sha" });
  const child = pullRequestFacts({ state: "MERGED", baseRef: "feature", mergedAt: "2026-11-01T10:00:00Z", mergeSha: "child-sha" });

  assertEquals(landingOf(child, () => parent), { kind: "landed", sha: "parent-sha", at: "2026-11-01T11:00:00Z" });
});

Deno.test("a reused branch name picks the PR that merged just after the child", () => {
  const child = pullRequestFacts({ number: 30, state: "MERGED", mergedAt: "2026-11-02T10:00:00Z" });
  const candidates = [candidate(20, "MERGED", "2026-11-01T10:00:00Z"), candidate(25, "MERGED", "2026-11-02T11:00:00Z"), candidate(28, "MERGED", "2026-11-03T11:00:00Z")];

  assertEquals(chooseParent(candidates, child)?.number, 25);
});

Deno.test("an open PR is chosen over older merged PRs that reused the branch", () => {
  const child = pullRequestFacts({ number: 30, state: "MERGED", mergedAt: "2026-11-02T10:00:00Z" });

  assertEquals(chooseParent([candidate(20, "MERGED", "2026-11-01T10:00:00Z"), candidate(29, "OPEN")], child)?.number, 29);
});

Deno.test("a PR is never its own parent", () => {
  const child = pullRequestFacts({ number: 30, state: "MERGED", mergedAt: "2026-11-02T10:00:00Z" });

  assertEquals(chooseParent([candidate(30, "MERGED", "2026-11-02T10:00:00Z")], child), null);
});

Deno.test("an approved, green, in-sync PR has no blockers", () => {
  assertEquals(mergeBlockers(pullRequestFacts(), []), []);
});

Deno.test("an approval on an older commit is called out", () => {
  const pullRequest = pullRequestFacts({ reviewDecision: "REVIEW_REQUIRED", approvals: [{ who: "grace", commit: "old" }] });

  assertEquals(kindsOf(mergeBlockers(pullRequest, [])), ["approval-outdated"]);
});

Deno.test("an approval on the head commit that GitHub doesn't count is called out", () => {
  const pullRequest = pullRequestFacts({ reviewDecision: "REVIEW_REQUIRED", approvals: [{ who: "grace", commit: "aaaaaaa1111111" }] });

  assertEquals(kindsOf(mergeBlockers(pullRequest, [])), ["approval-not-enough"]);
});

Deno.test("failing checks on a stale branch suggest updating it", () => {
  const [blocker] = mergeBlockers(pullRequestFacts({ failingChecks: ["unit"], behindBy: 3 }), []);

  assertEquals(blocker.text, "unit failing. The branch is 3 commits behind main, so the fix may already be there: update the branch first.");
});

Deno.test("a PR pointing at an older commit than its branch is out of sync", () => {
  assertEquals(kindsOf(mergeBlockers(pullRequestFacts({ branchTip: "bbbbbbb2222222" }), [])), ["out-of-sync"]);
});

Deno.test("a stuck merge check is reported", () => {
  assertEquals(kindsOf(mergeBlockers(pullRequestFacts({ mergeable: "UNKNOWN" }), [])), ["merge-check-stuck"]);
});

Deno.test("an active GitHub incident is listed first", () => {
  assertEquals(kindsOf(mergeBlockers(pullRequestFacts({ isDraft: true }), ["Actions"])), ["github-incident", "draft"]);
});

Deno.test("a stacked PR's partial read comes from the PR whose blockers it shows", () => {
  const parent = pullRequestFacts({ number: 11, isPartialRead: true });
  const child = pullRequestFacts({ state: "MERGED", baseRef: "feature", mergedAt: "2026-11-01T10:00:00Z" });

  assertEquals(deliveryOf(child, () => parent, [], [], provenance).isPartialRead, true);
});

Deno.test("a closed PR says so", () => {
  assertEquals(deliveryOf(pullRequestFacts({ state: "CLOSED" }), noParent, [], [], provenance).stage, "closed");
});

Deno.test("the stage is the furthest environment reached", () => {
  const merged = pullRequestFacts({ state: "MERGED", mergedAt: "2026-11-01T10:00:00Z", mergeSha: "m1" });
  const environments: EnvironmentResult[] = [
    { name: "staging", state: "deployed", at: "2026-11-01T10:20:00Z", detail: "" },
    { name: "production", state: "not-yet", at: "", detail: "" },
  ];
  const delivery = deliveryOf(merged, noParent, environments, [], provenance);

  assertEquals(delivery.stage, "on-staging");
  assertEquals(delivery.where, "On staging. Not on production yet.");
});

Deno.test("an environment it can't read says can't tell instead of not deployed", () => {
  const merged = pullRequestFacts({ state: "MERGED", mergedAt: "2026-11-01T10:00:00Z", mergeSha: "m1" });
  const environments: EnvironmentResult[] = [{ name: "production", state: "unknown", at: "", detail: "no successful run found." }];
  const delivery = deliveryOf(merged, noParent, environments, [], provenance);

  assertEquals(delivery.stage, "on-default-branch");
  assertEquals(delivery.where, "On main. Can't tell if it's on production: no successful run found.");
});

Deno.test("a repo with no environments stops at the default branch", () => {
  const merged = pullRequestFacts({ state: "MERGED", mergedAt: "2026-11-01T10:00:00Z", mergeSha: "m1" });

  assertEquals(deliveryOf(merged, noParent, [], [], provenance).where, "On main.");
});
