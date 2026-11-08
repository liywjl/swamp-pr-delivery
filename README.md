# @liywjl/pr-delivery

**Where is this pull request's code really, and if it isn't live, what's stopping it?**

GitHub's purple "Merged" badge only means a PR merged into *some* branch. This follows it the rest of the way: through stacked branches, onto the default branch, and into each environment you configure. It's read-only and uses no AI model.

## Install

```bash
swamp extension pull @liywjl/pr-delivery
swamp behavior create @liywjl/pr-delivery delivery
```

## Run it

```bash
swamp behavior run delivery trace --input 'urls=["https://github.com/acme/shop/pull/12"]'

swamp behavior run delivery trace --input 'query=repo:acme/shop is:pr author:@me is:merged' --input limit=20
```

Each PR is written as one `delivery` data item, named `acme--shop-12`:

```json
{
  "url": "https://github.com/acme/shop/pull/12",
  "stage": "merged-into-branch",
  "where": "Merged into checkout, not main. shop#11 has to land first.",
  "blockedBy": { "url": "https://github.com/acme/shop/pull/11", "label": "shop#11" },
  "blockers": [
    { "kind": "approval-outdated", "text": "grace approved an earlier commit, and GitHub still wants a review." }
  ],
  "landedSha": "",
  "isPartialRead": false,
  "environments": [],
  "source": "gh"
}
```

Use it from a workflow guard:

```yaml
guard: ${{ data.latest("delivery", "acme--shop-12").attributes.stage == "on-production" }}
```

## Stages

| Stage | Meaning |
| --- | --- |
| `closed` | Closed without merging |
| `in-review` | Open |
| `merged-into-branch` | Merged into another PR's branch, which still has to land |
| `stranded` | Merged, but its commits aren't on the default branch and nothing is taking them there |
| `on-default-branch` | Landed, not proven in any environment yet |
| `on-<environment>` | The furthest environment proven to contain it |

Before calling anything stranded it checks the commit graph, so a branch that reached the default branch another way counts as landed. If that check can't be done, the PR is reported as unreadable rather than stranded.

## Blockers

Plain reasons an open PR can't merge, most useful first. For a stacked PR, they're the blockers of the PR that has to land first.

`github-incident`, `out-of-sync`, `conflicts`, `merge-check-stuck`, `draft`, `checks-failing`, `checks-running`, `changes-requested`, `needs-review`, `approval-outdated`, `approval-not-enough`, `unresolved-threads`, `behind`

## Environments

Environments are configuration, listed from first to last. Each one says how to prove the code is there:

```yaml
globalArguments:
  environments:
    - name: staging
      commitStatus: deploy_staging
    - name: production
      githubDeployment: production
    - name: docs
      githubActionsWorkflow: publish.yml
```

- `commitStatus`: a commit status whose name contains this text. Covers CircleCI, Buildkite and most CI. A deploy of a later commit counts once it's confirmed to contain this one.
- `githubDeployment`: the newest successful GitHub Deployment to that environment, checked to contain this commit. Covers Actions, Vercel and Netlify.
- `githubActionsWorkflow`: the newest successful run of that workflow file on the default branch, checked to contain this commit.

If it can't read an environment, it says "can't tell" and why, never "not deployed".

## Reaching GitHub

The default is the `gh` CLI, using your existing login. It runs only `gh`, with arguments passed as a list and never through a shell. To use GitHub's MCP server instead:

```bash
swamp vault put default github-mcp-token
```

```yaml
globalArguments:
  transport: mcp
  mcpToken: ${{ vault.get("default", "github-mcp-token") }}
```

`mcpUrl` defaults to `https://api.githubcopilot.com/mcp/`. Every call asks the server for read-only tools.

GitHub's MCP server doesn't offer everything `gh` does:

| Capability | `gh` | `mcp` |
| --- | --- | --- |
| Stages, stacks and stranded PRs | Yes | Yes |
| Most blockers | Yes | Yes |
| Exact review decision | From GitHub | Inferred from reviews and merge state |
| "Commits behind" hint on failing checks | Yes | No |
| `githubActionsWorkflow` environments | Yes | Yes |
| `commitStatus` and `githubDeployment` environments | Yes | No: reported as "can't tell" |

## Limits

- github.com only for now.
- Stacks are followed up to 20 PRs deep.
- Reads up to 100 reviews, review threads and check runs per PR. `isPartialRead` is true if it may have hit that limit.
- A PR that was later reverted still shows the furthest stage its commit reached.
