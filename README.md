# ai-review

Line-by-line AI review on every TanksterAI pull request: £0, and no secrets anywhere.

It gives each pull request what CodeRabbit's Free plan does not: inline comments on real defects. CodeRabbit still posts its summary, and the Claude review in the merge gate is unchanged. This is a second, independent opinion from a different model. Its decision follows its findings, as CodeRabbit's Automatic Approvals do: it requests changes while it has findings, resolves its threads once later commits address them, and approves once none is open and the latest commit is reviewed in full (see "Posting, threads and approval"). With 0 required approvals neither decision blocks a merge. Its commit status, **Tankster AI Review**, reports whether every reviewable file was covered, and the merge gate requires that to pass (see "Full coverage").

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
                              - checks the budget, then drafts with the first provider in DRAFT_CHAIN
                                that can take the review
                              - checks every finding against the code, then has an independent model
                                try to refute it (see "Verified findings")
                              4. returns the review: only confirmed findings are shown, inline or in
                                 the review body
```

- **Free.** Workers AI gives the Cloudflare account 10,000 neurons a day at no charge. On the Workers Free plan it refuses work past that and never bills. Reviews take at most `DAILY_NEURON_CAP` (6,000) of it, so other Workers that use Workers AI keep room. A typical review costs 300-1,200 neurons, so expect roughly 5-15 reviews a day. Past the cap, or when the account's whole allocation is used, a review is deferred to the next UTC day: the job warns and stays green. If Workers AI is out of capacity the Worker tries once more after 3 seconds, then the job warns. With a Gemini or Anthropic key set, reviews also use those providers (see "Model providers" below), so one provider's quota no longer stops reviews.
- **Secretless.** The Worker holds no GitHub credential and the workflow holds no Cloudflare one. GitHub's per-job OIDC token is the only authentication, so there is nothing to create, store, rotate or leak. The Worker's address is fixed in `review.yml`, so the token goes nowhere else. Each token is good for one review, and only `review.yml` at the `v1` tag or `main` is trusted: a branch or an arbitrary commit of it is refused. The trust boundary is therefore write access to this repository: GitHub Free cannot enforce rulesets on a private repository, so anyone who can move `v1` or push to `main` decides what the Worker trusts. Keep that list to the owner and his agents.
- **Lean on CI.** The job runs on the light lane (Cloud Run, no Docker) and makes a few HTTPS calls. It uses no Actions minutes from the hosted pool and no Cloud Build minutes.
- **What a finding looks like** (CodeRabbit's format):
  - **Labels.** A severity (critical, major, minor, trivial or info), a type (potential issue, nitpick or refactor suggestion) and a category.
  - **A stable id.** Built from the file, the category and the title, so it stays the same when the code moves, as long as the title doesn't change. Ids are unique within a review, with a suffix such as `-2` for a repeat.
  - **One-click fix.** When the fix is local and certain, a committable `suggestion` block. It is kept only if all of these hold:
    - every line it replaces is on the new side of the diff the model was shown, so GitHub can commit it;
    - it spans at most 40 lines and 3,000 characters;
    - it changes something, and isn't empty (an empty suggestion would delete the lines);
    - the file doesn't use CRLF line endings.

    In an incremental review whose range has partly left the PR's diff, the comment stays on its line without the suggestion. A suggestion over several lines is a multi-line comment on that range.
  - **A "Prompt for AI agents" block.** It tells a coding agent exactly what to change and where.
  - **A machine-readable copy.** The review body's second line is an HTML comment, `<!-- tankster-ai-review:findings {...} -->`, holding every finding as JSON: id, place, labels, prompt, each suggestion with the original lines it replaces, and its verification (`status`, `verified_by`, and a `reason` the Worker writes). Findings that were not shown are there too, with their labels, status and reason only, and their path only when it names a file in the change. Agents and later commands (apply, resolve, track) read it from there, and the original lines let an apply refuse code that has moved on. The JSON escapes `<` and `>`, so nothing in it can close the comment.

  Check a suggestion before committing it, as with any change. The next review covers whatever it changed.
- **Safe with untrusted input.** The diff, title, description and the names of skipped files are fenced as data in the prompt. Model output is sanitised and can only become comments on this pull request. Its text has no @mentions, no issue references, no HTML tags or comments, no images, no links (inline, reference definitions in any container, or bare URLs) and no `suggestion` fences of its own, and its length is bounded.
  - **Code too.** This holds inside code spans and fences as well. Whether GitHub treats a backtick run as code depends on CommonMark's container blocks: a blockquote or list item ends a fence early, and a table splits a code span at `|`. Text taken for code could therefore render as prose.
  - **What that costs.** Inside real code the zero-width space added is invisible, but it is copied with the code.
  - **Where exact code goes.** Code meant to be copied goes in a suggestion block. The Worker writes that fence itself, longer than any run of backticks in the code, so it cannot be closed early. Agent prompts are fenced the same way.
  - **Comment layout.** An inline comment shows the one-line title and the finding id first, then the suggestion and the agent prompt, and the model's explanation last. A fence the explanation leaves open can therefore never take in the Worker's verbatim blocks. Character references (`&#...;`, `&name;`) are defused too, so none can spell a `suggestion` info string.
  - **Nothing can forge the findings.** The findings JSON sits on the line straight after the marker, before any model text, and only that line is read back.
  - **No tools, no content in logs.** The model has no tools. The Worker logs ids, counts and timings only, never code or model output.

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
GitHub ──webhook──▶ Worker /v1/github/webhook ──▶ PR Durable Object (state, single-use jobs)
                    (HMAC verified)                │ alarm, in steps (REVIEW_MODE=worker, the default)
                                                   ▼
                    read the PR and every file ─▶ batches ─▶ draft ─▶ ground ─▶ verify ─▶ one review
                    (read-only App token)          (coverage.js)                         + commit status
                                                                                         "Tankster AI Review"

REVIEW_MODE=runner (the earlier path): the alarm starts runner.yml (hosted runner, OIDC), which
sends the diff to Worker /v1/runner/review in one request (one prompt, at most 90,000 characters).
```

### Posting, threads and approval (as CodeRabbit)

Checked on 19 Nov 2026 against CodeRabbit's docs (Automatic Approvals, the request-changes workflow) and against what it did on TanksterAI/ai-review#14.

- **A review only when there is something to say.** A review with actionable findings is filed as **Changes requested**, with its inline comments. A review with only nitpicks (typed nitpick, or trivial or info severity, but never a critical, major or security finding) is filed as a comment: they are shown, and never block, as CodeRabbit's. A review with no findings posts no review at all; CodeRabbit does not either. Runner mode and v1 stay advisory: a comment review every time, with no summary comment, thread checks or approvals.
- **One summary comment, edited in place.** The first review creates it, and every later one edits it (its id is kept in the PR's object; a deleted one is posted again). It names the commit reviewed, the commits since the last review, "Actionable comments posted: N" or "No actionable comments were generated in the recent review. 🎉" (CodeRabbit's words), how many earlier threads were resolved, and the details (models, coverage, cost).
- **Earlier threads, re-checked on every review** (`addressed.js`). For each of the App's own open threads written at an earlier commit:
  - its file deleted since: addressed;
  - no change within 40 lines of the finding since its commit: left open, with no model call;
  - changed near it: one model (`ADDRESSED_CHAIN`, free models first, Claude Haiku last) reads the finding, the code it was about and the change, and answers fixed, present or uncertain. Only "fixed" counts. A critical, major or security finding also needs a second model, of another kind of provider, to say fixed; without one it stays open. A model with no usable answer hands over to the next. Kept findings are stored one key each, so none is ever dropped for space, and a thread list too long to read whole fails rather than approving on a partial one.

  An addressed thread gets CodeRabbit's note, "✅ Addressed in commit abc1234" (or "✅ Addressed in commits abc1234 to def5678" when the fix came in more than one commit, from the first commit after the finding's to the head), then is resolved. Anything unclear stays open for a person: no model could answer (the summary says so), the finding's commit is gone, or a force-push means its commit is no longer behind the head. A thread a person reopened by hand is never resolved by the reviewer again (the mark goes only when someone with write access resolves it, so one an outsider reopened and resolved waits for a writer). A diff near the finding too long to show whole is not judged; the thread stays open. Actionable findings a review could only list in its body (outside the diff, or ones GitHub would not place) are kept in the PR's object and checked the same way; one naming no file cannot be checked, so it is not kept. Each reopen mark and each accepted thread is stored under its own key, so none is ever evicted to make room: a mark stays until a writer resolves that thread, an acceptance until the thread is reopened, and both until the PR merges. A merged pull request's kept findings, marks, acceptances, summary comment id and approval notice are cleared.
- **Approval** (`pr-state.js` `decide`), checked after every complete review, every thread resolved or reopened by hand, and the commands. It approves the head when:
  - the latest commit has a complete review (100% coverage);
  - none of the App's own threads, and none of its body-only findings, is open. Every actionable finding blocks, whatever its severity; nitpicks never do (CodeRabbit's rule: they are not actionable comments). A thread resolved by someone without write access still counts as open, until a later review finds it fixed (it is then accepted, with the same note) or a writer's `resolve` or `approve` vouches for it. A command vouches only for the threads as they stood when it was posted: one reopened after that is neither resolved by it nor vouched for (the reopen marks are read again after each GitHub call), and a decision whose threads were read across a reopen is taken again from fresh reads, never approved from the old ones, and if an outsider then resolves it, it still counts as open. A thread the App resolved while a person's reopen still stands counts as open too, unless a command accepted it. Other people's threads, and the Claude review's threads, are theirs to manage;
  - it has not approved already;
  - the head is unchanged when it checks again just before approving.

  The approval has no text, as CodeRabbit's: the summary comment says why. Its **approval notice**, just under the heading, is rewritten whenever the decision changes. It reads "**Automatic approval withheld**" with a link to each open thread (up to 20) and the count of open body findings, or "**Automatic approval pending**" while the head has no complete review, or that it is approved at a commit. A thread of its own reopened after its approval **withdraws** the approval: the review is dismissed, as CodeRabbit withdraws its own, and the notice goes back to withheld. Only if GitHub refuses the dismissal is Changes requested filed instead. Drafts and closed pull requests are never approved.
- **`resolve` as a reply in one of its threads** (CodeRabbit's reference) resolves that thread only. The writer vouches for it, unless it is reopened after the command was posted, and an ordinary decision follows. In any other thread it does nothing. `approve` is never a command in a thread.
- **`resolve` and `approve`** (top-level comments by people with write access) do the same, as CodeRabbit's do: they resolve all of its threads, clear its body-only findings, and approve without waiting for a complete review of the latest commit. Up to 20 threads are resolved an alarm; the rest go in the next ones, and the decision is its own outbox item. A decision or one of these commands gets its alarm to itself: a review in progress takes its next step at the next alarm.

### Full coverage: every file, however big the pull request

The review used to put the whole diff in one prompt of at most 90,000 characters (20,000 a file), and skip whatever did not fit as "over the size budget". On large pull requests that left out every test file and the README, and still said "No material problems found". Now (PR C, TAN-278) the PR's Durable Object reviews the pull request itself, in steps of its alarm, and nothing is left out for size:

- **Every file is read.** The Worker lists the pull request's files with a read-only App token (GitHub lists up to 3,000). For a file GitHub sends without a patch (its API leaves the patch out of very large diffs), it fetches the old text (at the merge base) and the new text and works the diff out itself (`linediff.js`). Those findings go in the review body, since GitHub may not accept comments on lines of a diff it did not make.
- **Batches.** The whole diff is cut into batches of at most `BATCH_CHARS` (60,000) characters, one model call each (`coverage.js`): small prompts are more accurate. A file bigger than a batch is split at hunk boundaries, and a hunk bigger than a batch between lines, so every line is shown once, with its true line number. Code comes first, then tests, then docs, and each pass is told which other files are reviewed in the other passes.
- **No waiting while anything can work.** Up to 4 batches are drafted at once. Each batch tries the whole chain of free models, rotated so that batches running together use different free quotas; each Gemini model has its own. A model out of quota hands the batch to the next at once. Claude Haiku, on the plan's credit (`ANTHROPIC_DAILY_USD_CAP`), is last. A batch waits only when every drafter (or every verifier) is out, and only until the first resets; while nothing has been reviewed yet the commit status passes, as CodeRabbit's rate-limited run is neutral, saying "Review delayed: …" until the review's own result replaces it. Once some files are reviewed it stays pending, so a PR is never merged with files unreviewed. A held review that is given up, dropped or expired puts the commit back to pending.
- **Every finding is verified**, batch by batch, as in "Verified findings" below, and all of them go into one review (only when there are any: see "Posting, threads and approval").
- **What is never reviewed** is still named: deleted files, lockfiles and generated files (as CodeRabbit's default path filters skip them), binary files, and pure data files (`.csv`, `.tsv`, `.jsonl`, `.ndjson`, `.geojson`, `.topojson`, `.b64`, JSON under a `data/` or `fixtures/` folder, and text files other than dependency lists; manifests, config, SVG and XML count as code) whose added lines are over four batches long (240,000 characters: minified or generated data). Long lines are judged line by line, never the whole file by one line. An unchanged or removed line over 2,000 characters is context: it is cut to a marker so it cannot crowd out the change. An added line over 240,000 characters is cut to a marker too, and the file's other lines are still reviewed; in a data file it is named and passed over, but in any other file it is code no model read, so the file is **not covered** and the status fails (generated code belongs under `dist/` or in a `.min.js` file, which are skipped).
- **Only full coverage counts as done.** A review at 100% marks its commit `donefull:` and becomes the starting point of the next incremental review (`lastCompleteReviewed`). The single-prompt paths' `done:` mark and `lastReviewed` are never trusted for that, so the first review after this change covers the whole pull request.
- **Coverage is a gate.** The footer gives the coverage ("18 of 18 reviewable files (100%) … in 4 passes"), and the hidden findings block records it (`coverage: {reviewable, covered, complete}`). The commit status **Tankster AI Review** is `success` only when every reviewable file was covered, `failure` otherwise (an incomplete review also says so in its first line), and `pending` while the review runs or waits. The merge gate requires it.
- **Limits, stated rather than hidden.** Past `MAX_PR_CHARS` (5,000,000 characters of diff), past GitHub's 3,000-file list, or for a file over 5 MB, the rest is named as not covered and the status fails. A run waits at most three days for providers.
- **Steps stay inside Workers Free.** Each step's model and KV calls are counted against Workers Free's 50 subrequests an invocation (drafting shares 45 between its batches, and checks which providers are out of quota once a step); GitHub calls are bounded per step by design. An alarm may run for 15 minutes with 30 s of CPU. Memory stays bounded: a file's patch is stored apart from its record, and the plan loads only the patches that fit `MAX_PR_CHARS`. Every attempt at a step is counted before it runs, so one killed outright (out of memory or CPU) still counts, and six in a row give the run up. A step that fails is retried; the run's state is in the Durable Object's storage (`run:<job id>`). One review runs at a time per pull request; a push or command meanwhile waits for it, then reviews from where it stopped. Closing the pull request stops a review in progress.

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
  - The PR's Durable Object decides what happens. Each job it mints is single-use, and its record (kept in the object) names its repository, PR and commits.
  - The job's id names none of them: it is the object's Cloudflare id and a random part. This repository is public, and so are its runs' inputs and logs, so the runner's log lines say what happened but never which repository, PR, commit or model, nor the cost. The Worker's own logs keep those.
  - The runner proves who it is with its OIDC token. Only `runner.yml` on `main` is accepted.
  - It gets a read-only token for the one repository in the job, and revokes it at the end.
- **What the runner never gets.** It never holds the App's key, a write token or a model key. It also never runs code from the reviewed repository: it reads the diff through the API.
- **Who posts.** The Worker runs the model and posts the review.
- **Who gets reviewed automatically.**
  - An author whose association is not owner, member or collaborator is checked against the permission API first, because private org membership under-reports.
  - Bots (Renovate, Dependabot, an agent's App) are reviewed like writers when their branch is in the repository itself: pushing a branch there takes write access. `github-actions[bot]` is the exception, because workflows an outsider can drive open PRs as it, so its PRs wait like an outsider's.
  - PRs from forks (a bot's included) and from outside authors wait until someone with write access comments `@tankster-ai-review review`. Meanwhile their commit carries a pending **Tankster AI Review** status that says so, because the merge gate requires that status on every pull request. A commit already reviewed, or under review, keeps its own result.
  - A paused pull request gets no new status until a writer comments `@tankster-ai-review review` (which works while paused) or `resume`, so a required check waits for that.
- **Failures and retries.** The Durable Object performs one side effect per alarm. An item stays stored until its effect succeeds, and is retried up to five times.
- **Rate limits.** Replies to people without write access, and `help`, go out at most once an hour per person. Text that is not a command gets no reply.
- **What the App needs.** The manifest asks only for what it uses:
  - repository permissions: Metadata read, Contents read, Pull requests read and write (reviews, approvals, resolving its threads, the summary comment), Issues read (for `issue_comment` events), Actions read and write (to start `runner.yml`), and Commit statuses read and write (the coverage status);
  - events: `pull_request`, `issue_comment`, `pull_request_review_comment`, `pull_request_review_thread` (a thread resolved or reopened by hand decides the approval; added to the existing App on 19 Nov 2026).

  Later phases add permissions, and GitHub asks the owner to approve each addition. **Commit statuses** came with full coverage: the App created before it must be given it once (App settings → Permissions & events → Commit statuses: Read and write, then accept the request on the organisation's installation). Until then reviews are still posted, and the Worker logs `status_unavailable` instead of setting the status.
- **Commands.** `review`, `full review`, `pause` (or `ignore`), `resume`, `resolve`, `approve`, `rate limit` (whether a review can run now, or when) and `help`. Everything except `help` needs write access, checked through the API.
  - **Syntax, as CodeRabbit's:**
    - The handle starts a line, written as plain text: not in a fenced or indented code block, not in an HTML comment, and not after other text on the line. Case does not matter. Comments are read line by line, as GitHub's Markdown reads them, so no comment can make the parser slow.
    - One command per comment: the first such line counts.
    - `review` and `full review` must be alone on their line, so `review please` is not a command.
    - `pause`, `resume`, `resolve`, `approve`, `rate limit` and `help` must be the whole comment (nothing else, hidden text and code blocks included).
  - **Replies:**
    - `review` and `full review` answer "Action performed: Review triggered.", edited to "Review finished." when the review completes. A review that could cover only part of the files is edited to "Review finished." with how far it got. Every other end is "Action not completed" with the reason: the review gave up, could not start (its dispatch failed five times), expired before it could run, or the pull request was closed. No answer is left saying "Review triggered." for ever.
    - `review` on a head already reviewed in full answers "Action not completed: Already reviewed the last commit", and `full review` reviews it again.
    - A request that would change nothing is declined with its reason, whoever makes it (a person, or an agent): on a draft ("reviewed once it is marked ready"), on a closed pull request, and while a review of the last commit is already under way. Marking a draft ready reviews it by itself, so no comment is needed then. A draft gets one note when it is opened or converted: "Review skipped: this pull request is a draft…".
    - `pause` also says where the reviews stand: "Last reviewed commit" and "Latest commit, not reviewed".
    - `resume` also reviews, at once, the commits pushed while reviews were paused, unless the pull request is a draft or closed (it says so; those are reviewed once ready or reopened).
  - Every command works as a top-level comment. Only `resolve` also works as a reply in one of the App's threads, for that thread; in a thread, the others are not commands.
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

## The MCP server (for agents)

`POST /mcp` is a small MCP server (JSON-RPC over HTTP) so any agent can find out what the reviewer will do and ask it for something, without having to be taught. It is called with the caller's own GitHub token as a Bearer token; each call first checks that token can see the pull request, so a caller sees only what GitHub lets them see. Only `TanksterAI/*` repositories are served.

| Tool | What it does |
| --- | --- |
| `get_review_status` | Read-only. The PR's state (open, draft, reviewing, paused, closed), its head, the last reviewed head, `can_request_review` with the `reason` when not, and `next_action`: `wait`, `read_threads`, `mark_ready_for_review`, `resume`, `ask_a_writer_to_request_review` (a fork's pull request, reviewed only when someone with write access asks) or `none`. |
| `list_review_threads` | Read-only. The reviewer's own threads (open ones unless `include_resolved`), each with severity, category, file, line and finding id. |
| `request_review` | The request a `review` / `full review` comment makes (needs write access), refused with its reason when it would change nothing: a draft, a closed PR, a head under review, or (for `review`) a head already reviewed. |

The rules are kept here, not in an agent's memory. The server's `instructions` and the tool annotations tell an agent what to do, but that is advice; the refusals are decided by the PR's Durable Object from the PR as GitHub reports it and the state the reviewer keeps, the same rules a comment is held to. The merge gate is the backstop.

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
| Settings | `OWNER_ID`, `AUDIENCE`, `WORKFLOW_REFS`, `RUNNER_REFS`, `REVIEW_MODE`, `BATCH_CHARS`, `MAX_PR_CHARS`, `DRAFT_CHAIN`, `VERIFY_CHAIN`, `ESCALATE_CHAIN`, `VERIFY_FALLBACK`, `REVIEW_PROFILE`, `MODEL`, `REASONING_EFFORT`, `DAILY_NEURON_CAP`, `ANTHROPIC_DAILY_USD_CAP`, `MAX_DIFF_CHARS`, `MAX_OUTPUT_TOKENS` (see `worker/wrangler.jsonc`); optionally `BASE_BRANCHES` and `AUTO_PAUSE_AFTER` (below), `REVIEW_DEBOUNCE_S` and `REVIEW_DEBOUNCE_MAX_S` (v2's quiet period after a push, 180 and 900 seconds by default) `VERIFY_BUDGET_MS` (verification's time limit, 150,000 ms by default) and `REVIEW_DEADLINE_MS` (the whole review's, 270,000 ms) |
| Secrets | None needed. Optional: `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` add those providers (see below); `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` override the stored App |

`GET /healthz` shows today's neuron spend and each provider: whether it is set up and, if it is out of quota, until when. It never shows a key.

### Model providers

A review goes to the first provider in `DRAFT_CHAIN` that can take it. One that is out of quota, busy or failing hands over to the next. Each is free to us, and none may train on what we send:

| Provider | How it is paid | Data terms |
|---|---|---|
| Gemini API (`gemini:<model>`, with `GEMINI_API_KEY`) | The free tier, on a key whose project never has billing | For users in the UK, EEA and Switzerland the paid-service terms apply to the free tier: no training ([terms](https://ai.google.dev/gemini-api/terms)) |
| Cloudflare Workers AI (`workers-ai:<model>`) | The account's 10,000 free neurons a day; `DAILY_NEURON_CAP` of them for reviews | No training, no retention ([data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)) |
| Anthropic API (`anthropic:<model>`, with `ANTHROPIC_API_KEY`) | The Claude plan's monthly API credit, on a Console organisation with no card, so requests stop at zero and never bill. `ANTHROPIC_DAILY_USD_CAP` (default $5) bounds any one day | No training on API content ([Commercial Terms](https://www.anthropic.com/legal/commercial-terms), B) |

- **Without `DRAFT_CHAIN`,** the chain is Gemini Flash-Lite (when its key exists), then `MODEL` on Workers AI, then Claude Haiku (when its key exists).
- **Out of quota** marks that provider (for Gemini, that model) in KV until its reset:
  - Workers AI (3036): 00:00 UTC;
  - Gemini daily quotas: midnight Pacific;
  - Gemini minute limits: their retry delay;
  - spent Anthropic credit: six hours, then it looks again.
- **Queued, not dropped.**
  - When every provider is out, the PR's Durable Object holds the dispatch instead of starting a runner that can only defer. It checks again at least hourly, keeping the job fresh, and dispatches once one resets.
  - A review that defers anyway (because the last quota went mid-run, or a provider is out while another failed) is given back to the object and queued the same way. That wait never counts as a failure.
  - A provider that failed a review outright is skipped on that review's later tries (and by the capacity check), so it cannot keep a waiting review running and spending the others' quota.
  - A review that fails outright, or finds every provider busy with no time given, is tried again in 15 or 5 minutes. After 3 tries in all it stops, and says so on the pull request.
  - Waiting for quota never counts as a failure, but a job stops three days after its first run, with a note on the pull request.
  - Automatic reviews held while the PR is paused or made a draft are dropped; ones someone asked for still run.
- **Secrets.** Rishi creates and adds the keys himself. Add each as a Worker secret in the Cloudflare dashboard: Workers, then `tankster-ai-review`, then Settings, Variables and Secrets.
  - Gemini: a Google AI Studio key, with billing never enabled.
  - Anthropic: a Console key in an `ai-review` workspace with a spend limit, in the organisation linked to the plan's API credit.

Deploy only what is on `main`.

- **With wrangler:** `npx wrangler deploy -c worker/wrangler.jsonc`.
- **Through the Cloudflare API** (what Claude sessions use, via the Cloudflare connector):
  - Upload all seventeen modules in `worker/src`: `index.js`, `config.js`, `providers.js`, `oidc.js`, `review.js`, `grounding.js`, `verify.js`, `budget.js`, `github-app.js`, `webhook.js`, `pr-state.js`, `effects.js`, `setup.js`, `draft.js`, `coverage.js`, `linediff.js` and `review-run.js`.
  - Set `main_module: "index.js"` and include the bindings and settings from `wrangler.jsonc`.
  - Add the Durable Object bindings `{type: "durable_object_namespace", name: "PR_STATE", class_name: "PrState"}` and `{type: "durable_object_namespace", name: "APP_SECRETS", class_name: "AppSecrets"}`.
  - Keep the dashboard secrets with `keep_bindings: ["secret_text"]`.
  - On the first deploy only, send the migration `migrations: {new_tag: "v1", new_sqlite_classes: ["PrState", "AppSecrets"]}`.

## Verified findings

No model text reaches a review unless it has passed a deterministic grounding check and an independent model's attempt to refute it (TAN-299). That covers the comments, their suggestions and agent prompts, the body, and the findings record. Each finding passes four layers, in order:

1. **It carries evidence.** For every finding the drafter gives:
   - `evidence`: the exact line or lines (at most 5) of the new file it is about, copied from the diff;
   - `claim`: one sentence saying what is wrong;
   - `symbols`: the identifiers it depends on.

   The prompt says findings without verbatim evidence are discarded, and it never frames the change as bug-free. It asks for a line distinctive enough to find in the file and, when the cited line is generic (a lone brace, `return null;`), for a neighbouring line that is not.
2. **The grounding gate** (`worker/src/grounding.js`: no model, so free). It drops a finding when:
   - it is not about a file in the change: it has no file, or names one the model was not shown ("not about a file in the change");
   - it has no evidence ("no evidence");
   - its evidence is not where it says, or does not pick a line out. Whitespace aside:
     - **Lines with no content are ignored.** A line made only of punctuation, keywords (including word closers such as `end`, `endif`, `fi` and `done`, and Rust, Java, Kotlin and Ruby keywords), bare tags such as `</div>` or `<br/>`, and `null`, `nil`, `None`, `undefined`, `true`, `false`, such as `}`, `} else {` or `return null;`, neither counts nor needs to match. Any name or number, however short, is content: `if err != nil {` and `dx := x1 - x0` have some.
     - **Every line with content must be a line the model was shown** ("evidence not in the code"): for an inline finding, within 3 lines of the line it cites; for a finding outside the diff, anywhere in its file.
     - **At least one of them must be distinctive** ("evidence too thin"). For an inline finding, a line is distinctive if it occurs at most twice among the file's shown lines, or at most five times if it has a name of 3 or more characters that is not a keyword or a well-known name (`error` and `err` are well-known). So `const y = x / 0;` or `for (let i = 0; i <= n; i++) {` grounds a finding when it is unique in its file, and `} catch (error) {` does not when it repeats. A finding outside the diff matches anywhere in its file, so its line must occur there only once.

     Occurrences are counted once per file, as its shown lines are collected, so the check stays linear.
   - a name in its `symbols`, or in backticks in its title or claim, is not a whole word of the diff, the PR's title or its description, nor a language keyword or well-known global ("names something not in the change"). For a dotted path such as `a.b`, the last segment is checked. The body and the suggestion are not checked for names: a fix may add new ones.

   Evidence must come from the new file, so a finding about lines the change removed cannot be grounded and is dropped. A suggestion whose brackets, or open strings, differ from those of the lines it replaces is stripped, and its finding stays. In a JSON file, a suggestion for lines that balance must balance too. Every check is linear in what it reads.
3. **The verifier** (`worker/src/verify.js`). An independent model is asked to refute the findings, not to agree with them.
   - **What it sees.** Each finding's id, line, severity, title, claim, evidence, body, agent prompt and suggestion (the original lines and their replacement), with the PR's title and description and the diff of the finding's file, all fenced as data.
   - **What it answers,** for each finding:
     - `verdict`: `confirmed`, `refuted` or `uncertain`. A missing or unreadable verdict counts as uncertain;
     - `severity`: its own view. The finding is shown at the higher of the drafter's and the verifiers' severities;
     - `suggestion_ok` and `prompt_ok`: whether the suggestion and the agent prompt are right. A confirmed finding keeps its suggestion, and its prompt, only when these are `true`. Otherwise they are removed and the finding is shown without them.
   - **Few calls, at once.** The findings go in at most 4 calls (`VERIFY_MAX_CALLS`), run at the same time: one per file, with small files sharing a call when there are more than 4. Each call carries only its files' diffs.
   - **Budgets hold.** Before the calls start, each verifier's budget is checked against all of them together. If it can't cover them all, its calls go one at a time, each checked against what the ones before it spent. Each provider is one object per review, and each review has its own queue for ledger writes, which its drafting and verifying providers share: additions go in turn, so calls at the same moment cannot lose one another's spend. No review waits on another's queue.
   - **Every finding:** `VERIFY_CHAIN` (Claude Haiku 5.5) checks it.
   - **Critical and major findings,** by the drafter's severity or the verifier's, also need `ESCALATE_CHAIN` (Claude Sonnet 5.5) to confirm them. All of them go in one more call, with their files' diffs. Both verifiers must also pass the suggestion and the prompt. If the second check can't run, or the two disagree, the finding is unconfirmed; the review is not held for it.
   - **Time limits.** Both count from when the review started: verification ends by `VERIFY_BUDGET_MS` (150 seconds), and never later than `REVIEW_DEADLINE_MS` (270 seconds), the whole review's limit. Drafting starts no new provider and no retry in the last minute before that deadline, and each drafting call is given up if it has not answered by the deadline itself; either way the review is queued and tried again in 5 minutes (503).
     - A finding with no verdict by the deadline is unconfirmed.
     - If every call is late, or more than half the findings have no verdict, nothing is posted: the review is tried again in 5 minutes (503).
     - Calls still running at the deadline are not in the footer's cost, which then says "at least". Their ledgers still record what they spent.
   - **No model checks its own findings.** When no `VERIFY_CHAIN` provider can run (no key, out of quota, past the day's cap, or it wrote the findings itself), `VERIFY_FALLBACK` is used. That is never the drafter's own model, and one of a different kind comes first. The footer says which model verified instead, and why. A verifier of the drafter's own kind is a weaker check: the footer says so, and the finding's record has `weak: true`.
   - **When no verifier can run at all,** the review waits in the queue (429), as when every drafter is out. Findings are never posted unverified. The capacity check before a runner is dispatched plans the drafter (the first free one in `DRAFT_CHAIN`) and needs a verifier with a different id free too, so a review is not usually drafted only to wait. When the first free drafter is the only free verifier and another drafter is free, that other one is planned, and the review drafts with it first, by the same rule.
   - **Nothing a verifier writes in its own words is kept.** Every reason in the review is the Worker's, such as "refuted by claude-haiku-5-5".
4. **Placement**, following CodeRabbit's `chill` profile.

| Finding | Where it goes |
|---|---|
| Confirmed issue or refactor, minor or above, on a diff line | An inline comment, with its suggestion and agent prompt where the verifiers passed them |
| Confirmed nitpick, or trivial or info severity | `chill`: a collapsed "🧹 Nitpick comments" section of the review body, with its agent prompt only if the prompt passed verification, and never a suggestion. `assertive`: inline. `quiet`: collapsed in the same section, with everything below major (as CodeRabbit's quiet profile). `chill` also shows at most 20 inline comments: the least severe beyond them are collapsed in that section, never dropped, and still count as actionable |
| Confirmed, outside the diff | A collapsed "Outside diff range comments" section (`quiet` collapses its nitpicks into the Nitpick section) |
| Unconfirmed, refuted, or dropped by the grounding gate | The findings record only: never shown, never inline, and never counted as a finding |

- **How a comment reads, as CodeRabbit's.** A header line (`🟠 Major · Security & Privacy · Quick win`: severity, one of CodeRabbit's six categories, and an effort label when the model sees a quick win), then the finding id line, then the title in bold, the suggestion, the agent prompt and the body. Our own category keys (`bug`, `security`, `reliability`, `integrity`, `performance`, `tests`, `maintainability`) stay in finding ids, so ids do not change; the old `**Major (security): title**` line is still read, so earlier threads keep working. The review body adds a collapsed **Prompt to fix all issues** (every finding's prompt in one block, behind a safety preamble), and **Review info** (the commits it covered and the files selected). The summary comment lists the commits an incremental review covered (the latest 20, with the count).
- **What a hidden finding leaves behind.** The findings record keeps its id, labels, status and the Worker's reason, and its path only when that names a file in the change. None of its own text is kept: no title, body, claim, evidence, prompt or suggestion, anywhere in the review.
- **The summary is the Worker's own.** The drafter is still asked for a one-line summary, so its answer keeps the same shape, but that summary is never shown: nothing has verified it. The Worker writes the summary from the confirmed findings, for example "Reviewed 7 files. 3 findings confirmed: 1 major, 2 minor (plus 2 nitpicks)." or "No problems confirmed in the 7 files reviewed."
- **What the footer says.** A count line covers the findings shown. One verification line says how many were confirmed and by which models, and how many were not shown and why (counts only). For example: "Verified: 4 findings confirmed by `claude-haiku-5-5` (2 also by `claude-sonnet-5-5`); 3 not shown (1 refuted, 1 unconfirmed, 1 failed the evidence check)." The cost line adds what verification spent.

| Setting | Default | Meaning |
|---|---|---|
| `VERIFY_CHAIN` | `anthropic:claude-haiku-5-5` | Verifies every finding |
| `ESCALATE_CHAIN` | `anthropic:claude-sonnet-5-5` | The second verifier critical and major findings need |
| `VERIFY_FALLBACK` | `gemini:gemini-3.5-flash-lite,workers-ai:@cf/openai/gpt-oss-120b,workers-ai:@cf/zai-org/glm-4.7-flash` | Used only when no `VERIFY_CHAIN` provider can run |
| `REVIEW_PROFILE` | `chill` | `chill`, `assertive` or `quiet` (above) |
| *(merge queue)* | — | Subscribe the App to the `merge_group` event (App settings, Subscribe to events; new Apps made by the setup flow already are). Its queue commit then passes at once, as the PR was reviewed before it joined. |
| `BASE_BRANCHES` | empty (every base branch) | Comma-separated names or `*` patterns (`main, release/*`). A PR into any other branch is not reviewed automatically: its status passes, saying so; `@… review` still works. Leave it empty where the status is required |
| `AUTO_PAUSE_AFTER` | `0` (never) | CodeRabbit's auto-pause: after this many automatically reviewed commits, reviews pause with a notice until `@… resume` (CodeRabbit's default is 5). Reviews asked for by hand do not count. Leave it at 0 where the status is required, or a paused PR's new commits wait for someone to resume |
| `VERIFY_BUDGET_MS` | `150000` | Verification's time limit, in milliseconds from the review's start |
| `REVIEW_DEADLINE_MS` | `270000` | The whole review's time limit, in milliseconds; drafting stops a minute before it |
| `VERIFY` | unset | `off` confirms every finding unchecked. For tests and emergencies only: `wrangler.jsonc` never sets it, and the footer says when it is off |

These are Worker settings for now; a per-repository key (`reviews.profile` in `.ai-review.yml`) comes with TAN-286.

**Costs.**
- **Drafting:** nothing, on the free drafters at the front of `DRAFT_CHAIN`. The cheaper Workers AI models are in it now that every finding is verified.
- **Verifying:** a file's findings take about 6,000–8,000 input tokens and a few hundred output on Haiku, about $0.001. The one escalation call to Sonnet costs about $0.02.
- **A typical review:** 6–8 findings, 2 of them escalated, comes to about $0.03–0.05, paid from the plan's monthly API credit, in at most 5 verifier calls.
- **Limits:** `ANTHROPIC_DAILY_USD_CAP` ($5) bounds any one day. Past it, the free fallback verifiers take over. Workers AI verification counts against `DAILY_NEURON_CAP` like drafting.

## Review context

A model shown only a diff cannot tell a missing check from one that sits a few lines above the hunk, in the caller, or in the project's own rules. So each batch is shown, as read-only data beside its diff:

- **Guidelines:** `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md` and `.claude/rules/*.md`, read from the pull request's *base* commit, so a pull request cannot rewrite the rules it is judged by.
- **Changed files, after the change, with line numbers:** whole when they fit, otherwise the parts around the diff.
- **Related tests:** the test files that belong to a changed file, found by name.
- **Callers:** where a changed exported name is used elsewhere (GitHub code search of the default branch).

The verifier sees the same guidelines as the drafter and, for the file a finding is about, that file's context (the file, its tests and its callers), so a finding that the surrounding code answers is dropped rather than posted. It is not given the other files' context: each verifier call is paid for out of small free quotas. Everything is fenced as data (the model is told never to follow it). Files that are secrets by name (`.env*`, `.dev.vars`, keys and certificates, `credentials`, Terraform state and variables, service-account files, anything under a `secrets/` folder) are never read, and the common forms of a credential (private keys, cloud and API tokens, `password = "…"` style assignments with any prefix, URL passwords, bearer tokens) are blanked before it is sent. That blanking is a safety net, not a guarantee: keep secrets out of the repository.

`CONTEXT_CHARS` (default 36,000) caps what one batch carries, a quarter of it at most for the guidelines; `CONTEXT=off` sends the diff alone. A `.claude/rules` file may scope its rule with `paths:` or `globs:`; a scope with more than three runs of `*`, or with runs of `*` and brace alternatives past a small total, applies to every file, and a path over 200 characters matches no scope. The review's About block says what the models were shown, and when something was read but none of it fit the allowance. Context costs no extra model calls, only a few GitHub reads within the step's subrequest budget, and a read GitHub refuses is noted in the review's summary and skipped, and one that gets no answer at all is tried once more and then skipped the same way, so the review still runs on what was read.

## Limits worth knowing

- **What it reads.** It sees the diff, not the whole repository, so it can miss problems that need wider context. The App's review (REVIEW_MODE=worker) reads every reviewable file, in batches (see "Full coverage"). The single-prompt paths (v1's `review.yml`, and REVIEW_MODE=runner) still read at most 90,000 characters of diff, 20,000 per file, and list what they did not read; they set no coverage status, so they never satisfy the merge gate.
- **This repository's own CI runs on GitHub-hosted runners.** The repository is public, so they are free here, and the org's own runners refuse public repositories. The tests run on the Node 24 that the runner ships for JavaScript actions. `review.yml`, which private repositories call, still follows the org's `CI_RUNNER` and light lane.
- **CPU.** Workers Free allows 10 ms of CPU per request, so the single-prompt paths' workflows send at most 20,000 characters per file and 120,000 in total, and the Worker cuts each patch to the room left before it does any work on it. A Durable Object alarm has 30 s, which is why the full-coverage review runs there. The grounding gate collects the diff's words once and reads only a few lines per finding.
- **Verification narrows errors; it cannot end them.**
  - Two models can agree on a wrong finding.
  - The verifier sees the diff, and the context of the file a finding is about (see "Review context"), not the rest of the batch's context, so it can miss context that lies elsewhere.
  - A verifier's verdict on a suggestion or a prompt is a judgement, not a test run: nothing executes the code.
- **A review can still wait for a verifier after it has drafted.** The check before a runner is dispatched needs a drafter and a different verifier, both able to run. But a verifier can run out while the review runs, and with no verifier set up at all the check lets the review run so the fault shows. Then the review drafts, waits in the queue until a verifier resets, and drafts again when it runs.
- **Budget accuracy.** The ledger is in KV, which is eventually consistent and not atomic. Within one review, additions go in turn on the review's own queue and the verifier's calls are checked together (see "Verified findings"). Reviews that run at the same moment can each miss the others' spend, so a burst can overshoot the cap by several reviews. The check reserves each review's whole output allowance, which absorbs some of that. Past the cap, Cloudflare's own 10,000-neuron limit stops everything, never bills, and becomes a deferral. Replay protection is also only as strong as KV: a simultaneous replay is not stopped, but the cap bounds what it can cost.
- **Model output.** Reasoning counts as output. If the budget allows, the Worker tries once more, asking for no suggestions, when:
  - an answer is cut short (with low reasoning effort);
  - or an answer tried to be JSON but doesn't parse.

  An answer that still cannot be parsed moves on to the next provider; when none answers, the job fails with a reason. Whatever was used is still counted.

## Tests

```
npm test
```

This runs the following, against stand-ins:

- the Worker's OIDC verification, with a real RSA key pair;
- the budget, and the prompt and review building;
- the grounding gate and the verifier, with stand-in Gemini, Workers AI and Anthropic services, including a seeded random check that no unverified text (a hidden finding, the drafter's summary, an unpassed prompt or suggestion, an invented path) reaches a posted review;
- the HTTP handlers;
- v2's App authentication, again with a real PKCS#1 key;
- the one-time manifest setup, including its guards;
- webhook signatures and normalisation;
- the PR Durable Object, including outbox retries, rate limits and job claims;
- full coverage: batching and splitting (`coverage.test.js`), the line diff (`linediff.test.js`, against random edits), the review in steps (`review-run.test.js`: PR #9's shape at 100%, quota hand-over, waiting only when everything is out, files without a patch, the 50-subrequest bound, incremental reviews) and the PR object running it (`worker-mode.test.js`, including a PR closed mid-step);
- review context: what is read and what is never read, redaction, the budget and the fencing (`context.test.js`);
- the GitHub side effects;
- the workflows' own `github-script` steps, exactly as written in `review.yml`, `release-v1.yml` and `runner.yml`.

It also checks that `release-v1.yml` and `runner.yml` keep their guard rails.
