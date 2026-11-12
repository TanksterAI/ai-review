# ai-review

Line-by-line AI review on every TanksterAI pull request: £0, and no secrets anywhere.

It gives each pull request what CodeRabbit's Free plan does not: inline comments on real defects. CodeRabbit still posts its summary, and the Claude review in the merge gate is unchanged. This is a second, independent opinion from a different model, and it is advisory only: it never approves and never blocks.

## How it works

```
pull request opened ─▶ caller workflow (each repo)
                        └─▶ review.yml (this repo, reusable, light lane)
                              1. reads the PR and its changed files with the job's own GITHUB_TOKEN
                              2. asks GitHub for an OIDC token (audience tankster-ai-review)
                              3. POSTs the files to the Worker ──────────────┐
                              5. posts one COMMENT review with inline comments ◀┘
                                                                              │
                        tankster-ai-review Worker (Cloudflare) ◀───────────────┘
                              - verifies the OIDC token: GitHub's signature, our organisation
                                (numeric id 259206056), and job_workflow_ref = this repo's review.yml
                              - checks the daily budget, then runs @cf/openai/gpt-oss-120b on Workers AI
                              4. returns the review: findings it can place on a diff line go inline,
                                 the rest go in the review body
```

- **Free.** Workers AI gives the Cloudflare account 10,000 neurons a day at no charge. On the Workers Free plan it refuses work past that and never bills. Reviews take at most `DAILY_NEURON_CAP` (6,000) of it, so other Workers that use Workers AI keep room. A typical review costs 300-1,200 neurons, so expect roughly 5-15 reviews a day. Past the cap a review is deferred to the next UTC day: the job warns and stays green.
- **Secretless.** The Worker holds no GitHub credential and the workflow holds no Cloudflare one. GitHub's per-job OIDC token is the only authentication, so there is nothing to create, store, rotate or leak.
- **Lean on CI.** The job runs on the light lane (Cloud Run, no Docker) and makes a few HTTPS calls. It uses no Actions minutes from the hosted pool and no Cloud Build minutes.
- **Safe with untrusted input.** The diff, title and description are fenced as data in the prompt. Model output is sanitised (no @mentions, no HTML comments, bounded length) and can only become comments on this pull request. The model has no tools. The Worker logs ids, counts and timings only, never code or model output.

## Using it in a repository

Copy [`examples/ai-review.yml`](examples/ai-review.yml) to `.github/workflows/ai-review.yml`. It reviews a pull request when it is opened, reopened or marked ready for review. To review it again after new pushes:

- add the `ai-review` label, or
- run the workflow by hand: Actions → ai-review → Run workflow, with the PR number. A Claude session can do the same through the GitHub connector's workflow dispatch.

Each head commit is reviewed once. A repeat request for the same commit is skipped unless it is forced; the label and the manual run's `force` option both force it. Drafts and pull requests opened by bots are skipped (`skip-bots`), which saves budget for human and agent work.

## Inputs (`review.yml`)

| Input | Default | Meaning |
|---|---|---|
| `pr-number` | `0` | The PR to review; 0 means the triggering PR |
| `force` | `false` | Review a commit again |
| `skip-bots` | `true` | Skip PRs opened by bots |
| `endpoint` | the Worker's workers.dev URL | Where to send the review |
| `runs-on`, `light` | light lane | The usual estate runner inputs |

## The Worker

Source is in `worker/src`, as plain ES modules with no dependencies and no build step.

| Setting | Value |
|---|---|
| Name | `tankster-ai-review` |
| URL | https://tankster-ai-review.rishi-tank.workers.dev |
| Bindings | `AI` (Workers AI); `LEDGER` (KV `ai-review-ledger`: daily spend, and reviewed commits for 30 days) |
| Settings | `OWNER_ID`, `AUDIENCE`, `WORKFLOW_PREFIX`, `MODEL`, `REASONING_EFFORT`, `DAILY_NEURON_CAP`, `MAX_DIFF_CHARS`, `MAX_OUTPUT_TOKENS` (see `worker/wrangler.jsonc`) |

`GET /healthz` shows the model and today's spend.

Deploying: `npx wrangler deploy -c worker/wrangler.jsonc`, or upload the four modules through the Cloudflare API with the bindings in `wrangler.jsonc`. Claude sessions use the API through the Cloudflare connector. Deploy only what is on `main`.

## Limits worth knowing

- **What it reads.** It sees the diff, not the whole repository, so it can miss problems that need wider context. It reads up to 90,000 characters of diff, 20,000 per file. Code comes before tests and docs, and lockfiles and generated files are skipped. The review lists what it did not read.
- **CPU.** Workers Free allows 10 ms of CPU per request. The workflow therefore sends at most 25,000 characters per file and 250,000 in total, and the Worker does no work on files it cannot show.
- **Budget accuracy.** The ledger is in KV, which is eventually consistent, so two reviews at the same moment can overshoot the cap by one review. Cloudflare's own daily limit is the backstop.
- **Model output.** If the model's answer cannot be parsed, the job fails with a reason. The neurons it used are still counted.

## Tests

```
npm test
```

This runs the Worker's OIDC verification (with a real RSA key pair), the budget, the prompt and review building, the HTTP handler, and the workflow's own `github-script` step exactly as written in `review.yml`, against stand-ins.
