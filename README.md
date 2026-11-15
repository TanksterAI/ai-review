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
                                (numeric id 259206056), job_workflow_ref = this repo's review.yml at
                                v1 or main, and a token id never seen before
                              - checks the daily budget, then runs @cf/openai/gpt-oss-120b on Workers AI
                              4. returns the review: findings it can place on a diff line go inline,
                                 the rest go in the review body
```

- **Free.** Workers AI gives the Cloudflare account 10,000 neurons a day at no charge. On the Workers Free plan it refuses work past that and never bills. Reviews take at most `DAILY_NEURON_CAP` (6,000) of it, so other Workers that use Workers AI keep room. A typical review costs 300-1,200 neurons, so expect roughly 5-15 reviews a day. Past the cap, or when the account's whole allocation is used, a review is deferred to the next UTC day: the job warns and stays green. If Workers AI is out of capacity the Worker tries once more after 3 seconds, then the job warns.
- **Secretless.** The Worker holds no GitHub credential and the workflow holds no Cloudflare one. GitHub's per-job OIDC token is the only authentication, so there is nothing to create, store, rotate or leak. The Worker's address is fixed in `review.yml`, so the token goes nowhere else. Each token is good for one review, and only `review.yml` at the `v1` tag or `main` is trusted: a branch or an arbitrary commit of it is refused. The trust boundary is therefore write access to this repository: GitHub Free cannot enforce rulesets on a private repository, so anyone who can move `v1` or push to `main` decides what the Worker trusts. Keep that list to the owner and his agents.
- **Lean on CI.** The job runs on the light lane (Cloud Run, no Docker) and makes a few HTTPS calls. It uses no Actions minutes from the hosted pool and no Cloud Build minutes.
- **Safe with untrusted input.** The diff, title, description and the names of skipped files are fenced as data in the prompt. Model output is sanitised and can only become comments on this pull request. Its prose has no @mentions, no HTML tags or comments, no images and no links (inline, reference or bare URLs), and its length is bounded. Code spans and fenced blocks are left exactly as written, since GitHub renders nothing inside them, so code copied from a finding is what the model wrote. The model has no tools. The Worker logs ids, counts and timings only, never code or model output.

## Using it in a repository

Copy [`examples/ai-review.yml`](examples/ai-review.yml) to `.github/workflows/ai-review.yml`. It calls `review.yml` at `@main` until a `v1` tag is cut (the Worker trusts both; see [Releasing v1](#releasing-v1)), and reviews a pull request when it is opened, reopened or marked ready for review. To review it again after new pushes:

- add the `ai-review` label (remove it first if it is already there), or
- run the workflow by hand: Actions → ai-review → Run workflow, with the PR number. A Claude session can do the same through the GitHub connector's workflow dispatch.

Each head commit is reviewed once. A repeat request for the same commit is skipped, unless the manual run's `force` option is set or the job is a re-run (which covers a review that failed to post). These are not reviewed:

- drafts;
- pull requests from forks, which get no OIDC token;
- pull requests opened by the logins in `skip-authors` (Renovate and Dependabot by default), to save budget for human and agent work.

This repository's own pull requests are reviewed by hand. Its `ai-review.yml` runs only from Actions → Run workflow, on `main`, because a run on a pull-request ref calls `review.yml` at `refs/pull/N/merge`, which the Worker refuses by design.

**Before another repository can call `review.yml`**, this repository's Settings → Actions → General → Access must be "Accessible from repositories in the 'TanksterAI' organization". A private repository's reusable workflows are closed to other repositories by default. It was set on 12 Nov 2026.

## v2: the Tankster AI Review GitHub App (in progress)

v2 moves to an org-wide GitHub App, **Tankster AI Review**. It needs no caller file in each repository, and it adds chat, commands and incremental reviews. The aim is parity with CodeRabbit and beyond. The design is in the Tankster AI project notes (`ai-review-v2-coderabbit-parity-design-2026-11-12.md`), and the work is tracked in Linear project "ai-review v2: CodeRabbit parity".

```
GitHub ──webhook──▶ Worker /v1/github/webhook ──▶ PR Durable Object ──alarm──▶ workflow_dispatch
                    (HMAC verified)                (state, single-use jobs)     │
                                                                                ▼
                    Worker /v1/runner/review ◀── runner.yml (this repo, light lane, OIDC)
                    model, then posts as tankster-ai-review[bot]
```

- **When it reviews** (as CodeRabbit does):
  - **Opened, reopened, or marked ready for review:** at once. That covers the whole PR the first time, and the commits since the last review after that. Drafts wait until they are marked ready, and converting a PR to a draft drops a push that is still waiting.
  - **New commits:** incrementally, covering the commits since the last review.
    - Each push starts a quiet period, and the review begins 3 minutes after the last push. A steady stream of pushes is still reviewed 15 minutes after the first push it covers.
    - `REVIEW_DEBOUNCE_S` (default 180) and `REVIEW_DEBOUNCE_MAX_S` (default 900) set the two times.
    - The starting point is the last review that had finished when the runner took the job. A review still running at that moment can therefore overlap with the next one.
    - When reviews overlap, the one taken later counts as the last review, whichever finishes first.
    - A push counts as covered once a review finishes whose run took its job after the push, because the runner reads the latest commit when it starts. The push waits instead of making another job while a job is still on its way:
      - its dispatch is queued;
      - or its dispatch went out within the last 15 minutes;
      - or a run took it after the push, within the last 15 minutes, and has not finished.

      If that window ends without such a review, the runner or its run is presumed lost, and the push gets its own review. Waiting pushes are checked again no more often than every 30 seconds. A dispatch that fails five times is dropped together with its job.
  - **On request:** `@tankster-ai-review review` (the commits since the last review) or `full review` (the whole PR), at once. Either one covers a push that is still waiting.
  - **Not while** the PR is paused (`pause`) or closed. Closing drops the PR's jobs and their waiting dispatches.
- **Who decides what.**
  - The PR's Durable Object decides what happens. Each job it mints is single-use and names its own repository, PR and commits.
  - The runner proves who it is with its OIDC token. Only `runner.yml` on `main` is accepted.
  - It gets a read-only token for the one repository in the job, and revokes it at the end.
- **What the runner never gets.** It never holds the App's key, a write token or a model key. It also never runs code from the reviewed repository: it reads the diff through the API.
- **Who posts.** The Worker runs the model and posts the review.
- **Who gets reviewed automatically.**
  - An author whose association is not owner, member or collaborator is checked against the permission API first, because private org membership under-reports.
  - PRs from forks, outside authors and bots wait until someone with write access comments `@tankster-ai-review review`.
- **Failures and retries.** The Durable Object performs one side effect per alarm. An item stays stored until its effect succeeds, and is retried up to five times.
- **Rate limits.** Replies to people without write access, and `help`, go out at most once an hour per person. Text that is not a command gets no reply.
- **What the App needs.** The manifest asks only for what P1 uses:
  - repository permissions: Metadata read, Contents read, Pull requests read and write, Issues read (for `issue_comment` events), and Actions read and write (to start `runner.yml`);
  - events: `pull_request`, `issue_comment`, `pull_request_review_comment`.

  Later phases add permissions, and GitHub asks the owner to approve each addition.
- **Commands.** `review`, `full review`, `pause`, `resume` and `help`. Everything except `help` needs write access, checked through the API.
- **Secrets: nobody handles them.** The App is created once, from a manifest:
  - Open `https://tankster-ai-review.rishi-tank.workers.dev/v1/setup/github-app` and press the button. GitHub creates the App in TanksterAI.
  - GitHub hands its id, slug, private key and webhook secret straight to the Worker (`POST /app-manifests/{code}/conversions`). The Worker keeps them in the `AppSecrets` Durable Object, which no route exposes.
  - The page then links to installing the App.
  - The flow is guarded:
    - its state is valid for an hour, until setup succeeds;
    - an App owned by anyone else, or one that comes back incomplete, is refused;
    - once an App is stored, setup is closed.
  - If GitHub fails to convert the code, the same callback link can be reloaded within the hour. If an App ends up created without stored keys, the page names it and links to deleting it.
  - **Where the keys live.** Unlike Worker secrets, which cannot be read back, Durable Object storage can be browsed in the Cloudflare dashboard (Data Studio). So anyone with dashboard access to the account can read the stored key. The client id and secret are not kept.
  - **Recovery.** Setup cannot be reopened once it has succeeded. If the key leaks or the App is deleted, set the Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` (and `GITHUB_APP_SLUG` if it changed); they win over the stored App. Otherwise reopen setup with a code change. Each isolate caches the App's config for up to 5 minutes.
- **Mentions.** The App's slug decides how it is mentioned (`@<slug>`), its login (`<slug>[bot]`) and the commands its replies name. `@tankster-ai-review` above assumes the default slug.

## Releasing v1

After a change to `review.yml` or the Worker is merged and deployed, run Actions → release-v1 → Run workflow, on `main`. It creates `v1` at `main`, or moves it forward to `main`. It never moves `v1` back or sideways: it compares the two first and refuses unless `main` is ahead, so an older `review.yml` cannot become trusted again by a click. Moving `v1` back is for the owner, by hand.

GitHub will not let the job's own token move a tag across commits that change `.github/workflows`, because that needs the `workflows` permission, which a job token cannot be given. When that happens the run fails and prints the `git push` command that moves `v1` by hand.

## Inputs (`review.yml`)

| Input | Default | Meaning |
|---|---|---|
| `pr-number` | `0` | The PR to review; 0 means the triggering PR |
| `force` | `false` | Review a commit again |
| `skip-authors` | `renovate[bot],dependabot[bot]` | Logins whose PRs are not reviewed |
| `runs-on`, `light` | light lane | The usual estate runner inputs |

## The Worker

Source is in `worker/src`, as plain ES modules with no dependencies and no build step.

| Setting | Value |
|---|---|
| Name | `tankster-ai-review` |
| URL | https://tankster-ai-review.rishi-tank.workers.dev |
| Bindings | `AI` (Workers AI); `LEDGER` (KV `ai-review-ledger`: daily spend, reviewed commits for 30 days, and used token ids until they expire); `PR_STATE` (Durable Object class `PrState`, SQLite-backed: one per pull request); `APP_SECRETS` (Durable Object class `AppSecrets`: the GitHub App's credentials, from the manifest flow) |
| Settings | `OWNER_ID`, `AUDIENCE`, `WORKFLOW_REFS`, `RUNNER_REFS`, `MODEL`, `REASONING_EFFORT`, `DAILY_NEURON_CAP`, `MAX_DIFF_CHARS`, `MAX_OUTPUT_TOKENS` (see `worker/wrangler.jsonc`); optionally `REVIEW_DEBOUNCE_S` and `REVIEW_DEBOUNCE_MAX_S` (v2's quiet period after a push, 180 and 900 seconds by default) |
| Secrets | None needed. Optional: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` override the stored App |

`GET /healthz` shows the model and today's spend.

Deploy only what is on `main`.

- **With wrangler:** `npx wrangler deploy -c worker/wrangler.jsonc`.
- **Through the Cloudflare API** (what Claude sessions use, via the Cloudflare connector):
  - Upload all nine modules in `worker/src`: `index.js`, `oidc.js`, `review.js`, `budget.js`, `github-app.js`, `webhook.js`, `pr-state.js`, `effects.js` and `setup.js`.
  - Set `main_module: "index.js"` and include the bindings and settings from `wrangler.jsonc`.
  - Add the Durable Object bindings `{type: "durable_object_namespace", name: "PR_STATE", class_name: "PrState"}` and `{type: "durable_object_namespace", name: "APP_SECRETS", class_name: "AppSecrets"}`.
  - Keep the dashboard secrets with `keep_bindings: ["secret_text"]`.
  - On the first deploy only, send the migration `migrations: {new_tag: "v1", new_sqlite_classes: ["PrState", "AppSecrets"]}`.

## Limits worth knowing

- **What it reads.** It sees the diff, not the whole repository, so it can miss problems that need wider context. It reads up to 90,000 characters of diff, 20,000 per file. Code comes before tests and docs, and lockfiles and generated files are skipped. The review lists what it did not read.
- **Light runner.** It cannot start a Node binary downloaded by `actions/setup-node` (its image has no `libatomic.so.1`), so this repository's CI runs the tests on the Node 24 that the runner ships for JavaScript actions. The review job is a JavaScript action and is unaffected.
- **CPU.** Workers Free allows 10 ms of CPU per request. The workflow therefore sends at most 20,000 characters per file and 120,000 in total, and the Worker cuts each patch to the room left before it does any work on it.
- **Budget accuracy.** The ledger is in KV, which is eventually consistent and not atomic. Reviews that run at the same moment can each miss the others' spend, so a burst can overshoot the cap by several reviews. The check reserves each review's whole output allowance, which absorbs some of that. Past the cap, Cloudflare's own 10,000-neuron limit stops everything, never bills, and becomes a deferral. Replay protection is also only as strong as KV: a simultaneous replay is not stopped, but the cap bounds what it can cost.
- **Model output.** Reasoning counts as output. If an answer is cut short, the Worker tries once more with low reasoning effort, when the budget allows. An answer that still cannot be parsed fails the job with a reason, and the neurons it used are still counted.

## Tests

```
npm test
```

This runs the following, against stand-ins:

- the Worker's OIDC verification, with a real RSA key pair;
- the budget, and the prompt and review building;
- the HTTP handlers;
- v2's App authentication, again with a real PKCS#1 key;
- the one-time manifest setup, including its guards;
- webhook signatures and normalisation;
- the PR Durable Object, including outbox retries, rate limits and job claims;
- the GitHub side effects;
- the workflows' own `github-script` steps, exactly as written in `review.yml`, `release-v1.yml` and `runner.yml`.

It also checks that `release-v1.yml` and `runner.yml` keep their guard rails.
