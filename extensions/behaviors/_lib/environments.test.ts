import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { environmentFromStatuses, readEnvironments } from "./environments.ts";
import { fakeSource } from "./fixtures.ts";
import type { CommitWithStatuses } from "./types.ts";

const landed = { repo: "acme/shop", defaultBranch: "main", sha: "landed", at: "2026-11-01T10:00:00Z" };

const alwaysContained = () => Promise.resolve(true);

function commit(sha: string, state?: string): CommitWithStatuses {
  const statuses = state ? [{ context: "deploy_staging", state, updatedAt: `2026-11-01T10:${sha.length}0:00Z` }] : [];

  return { sha, statuses };
}

Deno.test("a deploy of a later commit counts for the landed commit", async () => {
  const newestFirst = [commit("later", "SUCCESS"), commit("landed")];

  assertEquals((await environmentFromStatuses("staging", newestFirst, "deploy_staging", "landed", alwaysContained)).state, "deployed");
});

Deno.test("a later deploy that doesn't contain the commit doesn't count", async () => {
  const newestFirst = [commit("later", "SUCCESS"), commit("landed")];
  const result = await environmentFromStatuses("staging", newestFirst, "deploy_staging", "landed", () => Promise.resolve(false));

  assertEquals(result.state, "not-yet");
});

Deno.test("too many deploys to check is can't tell, not missing", async () => {
  const older = Array.from({ length: 11 }, (_, index) => commit(`deploy${index}`, "SUCCESS")).reverse();
  const newestFirst = [...older, commit("landed")];
  const result = await environmentFromStatuses("staging", newestFirst, "deploy_staging", "landed", () => Promise.resolve(false));

  assertEquals(result.state, "unknown");
});

Deno.test("a failed deploy of a commit that doesn't contain it isn't its failure", async () => {
  const newestFirst = [commit("other", "FAILURE"), commit("landed")];
  const result = await environmentFromStatuses("staging", newestFirst, "deploy_staging", "landed", () => Promise.resolve(false));

  assertEquals(result.state, "not-yet");
});

Deno.test("a running deploy that contains it is deploying", async () => {
  const newestFirst = [commit("later", "PENDING"), commit("landed")];

  assertEquals((await environmentFromStatuses("staging", newestFirst, "deploy_staging", "landed", alwaysContained)).state, "deploying");
});

Deno.test("a deploy of a commit before it landed doesn't count", async () => {
  const newestFirst = [commit("landed"), commit("before", "SUCCESS")];

  assertEquals((await environmentFromStatuses("staging", newestFirst, "deploy_staging", "landed", alwaysContained)).state, "unknown");
});

Deno.test("a failed deploy names the job", async () => {
  const result = await environmentFromStatuses("staging", [commit("landed", "FAILURE")], "deploy_staging", "landed", alwaysContained);

  assertEquals([result.state, result.detail], ["failed", "deploy_staging"]);
});

Deno.test("a running deploy is deploying", async () => {
  assertEquals((await environmentFromStatuses("staging", [commit("landed", "PENDING")], "deploy_staging", "landed", alwaysContained)).state, "deploying");
});

Deno.test("a deploy that doesn't contain the commit is not yet there", async () => {
  const source = fakeSource({
    latestDeployment: () => Promise.resolve({ sha: "older", at: "2026-11-01T09:00:00Z" }),
    contains: () => Promise.resolve(false),
  });
  const [result] = await readEnvironments(source, [{ name: "production", githubDeployment: "production" }], landed);

  assertEquals(result.state, "not-yet");
});

Deno.test("a deploy that contains the commit is deployed, with its time", async () => {
  const source = fakeSource({
    latestWorkflowRun: () => Promise.resolve({ sha: "newer", at: "2026-11-01T11:00:00Z" }),
    contains: () => Promise.resolve(true),
  });
  const [result] = await readEnvironments(source, [{ name: "production", githubActionsWorkflow: "deploy.yml" }], landed);

  assertEquals([result.state, result.at], ["deployed", "2026-11-01T11:00:00Z"]);
});

Deno.test("a read that fails is unknown with the reason, not a failure of the run", async () => {
  const source = fakeSource({ commitsSince: () => Promise.reject(new Error("no tool for commit statuses.")) });
  const [result] = await readEnvironments(source, [{ name: "staging", commitStatus: "deploy" }], landed);

  assertEquals([result.state, result.detail], ["unknown", "no tool for commit statuses."]);
});

Deno.test("a landed PR with no merge commit found is unknown", async () => {
  const [result] = await readEnvironments(fakeSource(), [{ name: "staging", commitStatus: "deploy" }], { ...landed, sha: "" });

  assertEquals(result.detail, "couldn't find its merge commit.");
});
