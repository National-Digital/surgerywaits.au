# Contributing

surgerywaits.au shows public hospital planned-surgery waiting times in Australia. It is built on
[publicdata.au](https://publicdata.au/) as a worked example of a site that takes all its data from
that service. Contributions are welcome: a bug fix, a correction to how the site processes a
figure, a clearer page, or an accessibility improvement.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
privately as [SECURITY.md](SECURITY.md) describes.

## Ground rules

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#rules-that-decide-the-code) states the project's
rules, one line each, and names the test or check that enforces each. A rule whose test is still
pending is applied by reviewers until the test lands. Read that section before you change anything
that shows data, copy or markup.

## Setting up

You need Node 26, Python 3.13 and `uv` 0.13.7. No credentials are needed to build or test.

```
git config core.hooksPath .githooks   # sign-off, lint and test hooks
npm ci
cd pipeline
uv sync
```

`uv` reads `pipeline/.python-version` and downloads that Python when it is missing. The root
`.node-version` names the Node release, and `engine-strict` in `.npmrc` makes `npm` refuse another.

### Running the checks

From the repository root:

```
npm run lint            # ESLint, no warnings, every disable needs a reason
npm run format:check    # Prettier
npm run typecheck       # astro check on the site, tsc on the Worker and the scripts
npm run knip            # unused files, exports and dependencies
npm test                # vitest, without the browser proofs
A11Y_TEST=1 npx vitest run scripts/a11y.test.ts   # the accessibility proofs, which need Chromium
npm run build           # astro build
npm run a11y            # accessibility checks on their fixture pages (npx playwright install chromium first)
npm run worker:types:check   # fails when worker/worker-configuration.d.ts is stale
npm run worker:dry-run -- /tmp/worker-out   # wrangler deploy --dry-run, no credentials
```

After you change `worker/wrangler.jsonc`, run `npm run worker:types` and commit the regenerated
`worker/worker-configuration.d.ts`. The runtime types come from `@cloudflare/workers-types`, so the
generated file holds only the bindings. Run `npm run build` before the dry run, because the Worker's
assets come from the Astro build.

From `pipeline/`:

```
uv run ruff check
uv run ruff format --check
uv run pyright
uv run pytest
```

ESLint reads `eslint.config.ts` through `jiti`, and the
`@eslint-community/eslint-plugin-eslint-comments` plugin fails any inline disable that has no
description. Ruff selects every rule and ignores only the few listed with a reason in
`pipeline/pyproject.toml`. Pytest runs with `--strict-markers`, `--strict-config`, `-W error` and
`xfail_strict`. The `Workflow lint` job also runs shellcheck over `.githooks/*` and every `*.sh`
file.

### Git hooks

`git config core.hooksPath .githooks` turns on three hooks.

- `prepare-commit-msg` adds the `Signed-off-by` trailer when it is missing.
- `pre-commit` runs ESLint and Prettier on the staged site files and ruff on the staged Python
  files. It runs shellcheck on staged `.githooks/*` and `*.sh` files. When files under `.github/`
  are staged it also runs actionlint with shellcheck, and zizmor. A tool that is not installed
  fails the commit with a message naming it.
- `pre-push` runs `typecheck`, `knip`, `vitest`, pyright and pytest.

Skip a hook once with `--no-verify`. CI runs the same checks on every pull request.

## Making a change

1. Branch from `main`.
2. Make the change, and keep to one concern. An unrelated fix found on the way gets its own pull
   request.
3. Open a pull request. The template asks what changed, why, and how you checked it. It also asks
   for a Docs line: the library, its version and the official documentation page you followed.
   Name anything a maintainer must do beyond merging.

## Commits and pull requests

- Sign off every commit with `git commit -s`. The sign-off is the
  [Developer Certificate of Origin](https://developercertificate.org/): you certify that you wrote
  the change or have the right to submit it under the project's licence. The Check sign-off job
  fails a pull request that has an unsigned commit, and `git rebase --signoff main` followed by a
  force-push adds the missing lines.
- Title the pull request as a Conventional Commit, `<type>(<scope>): <subject>`. The types are
  `feat`, `fix`, `docs`, `chore`, `perf`, `refactor`, `test`, `build`, `ci`, `style`, `revert` and
  `data`. The scope is optional.
- Pull requests are squash-merged, so the title becomes the commit subject on `main`.
- A pull request merges when every required check is green.

## Checks on each pull request

| Check                           | What it does                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Check sign-off                  | Confirms every commit has a `Signed-off-by` line.                                                             |
| Check title                     | Confirms the pull request title is a Conventional Commit.                                                     |
| Secret scan (gitleaks)          | Scans the full history for credentials.                                                                       |
| Workflow lint                   | Lints the workflow files under `.github/workflows/` and every shell file.                                     |
| Review dependency changes       | Fails on a new dependency with a known high or critical vulnerability.                                        |
| Analyze (actions)               | Runs CodeQL static analysis on the workflows.                                                                 |
| Analyze (javascript-typescript) | Runs CodeQL static analysis on the TypeScript and JavaScript.                                                 |
| Analyze (python)                | Runs CodeQL static analysis on the Python.                                                                    |
| Site checks                     | Runs ESLint, Prettier, `astro check` and the TypeScript compiler, knip and vitest.                            |
| Worker build                    | Builds the site, checks the generated Worker types are current and runs `wrangler deploy --dry-run`.          |
| Pipeline checks                 | Runs ruff, pyright and pytest on the pipeline.                                                                |
| Accessibility                   | Proves each accessibility check fires on a page built to fail it, at two widths in light and dark.            |
| Repository tests                | Checks every workflow against the repository's rules, such as pinned actions and least-privilege permissions. |

More checks will join this list as the pipeline and the site are built, and each is added here
when it starts to run.

### How CI runs

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main` with five jobs
whose names are stable enough to require as status checks.

- `Site checks` runs `npm ci`, then lint, format check, typecheck, knip and vitest.
- `Worker build` runs `npm ci`, `astro build`, the `wrangler types --check` freshness check and
  `wrangler deploy --dry-run` into a temporary directory. It uses no Cloudflare credential or
  account identifier, and nothing is deployed.
- `Pipeline checks` installs the `uv` version in `pipeline/uv.toml`, runs `uv sync --locked`, then
  ruff, pyright and pytest. It leaves out `tests/test_repo.py` and `tests/test_docs.py`, because
  the next job runs them.
- `Accessibility` installs Chromium with `npx playwright install --with-deps chromium`, then runs
  `npm run a11y` and the tests in `scripts/a11y.test.ts`. The first proves each accessibility
  check fires on its fixture page in `scripts/a11y-fixtures/`. See
  [`ACCESSIBILITY.md`](docs/ACCESSIBILITY.md).
- `Repository tests` runs `pipeline/tests/test_repo.py` and `pipeline/tests/test_docs.py`. The
  second fails when a document links to a missing file or heading, names a missing path or npm
  script, lists a check that no workflow defines, or cites a test, pending test or CI job in
  `docs/ARCHITECTURE.md` that does not exist. The first reads every workflow and checks
  that jobs with side effects are guarded by the repository name, that no pull request workflow
  runs Lighthouse or PageSpeed Insights, that `pull_request_target` is unused, that every action
  is pinned to a commit SHA with a version comment, that each workflow declares top-level
  `permissions:`, that each job runs on a named image, and that every scheduled workflow reports
  its failures through the reusable workflow.

### Scheduled runs

`.github/workflows/report-scheduled-run.yml` is a reusable workflow that keeps one open GitHub
issue per failing scheduled job. A failure opens the issue, or comments on it when one is open.
The next success closes it. It uses the run's own token with `issues: write`, in a job that runs
only in the public repository, and creates its label if the label is missing. `codeql.yml` calls
it from a `report` job on the weekly run with the label `scheduled-codeql`. Every workflow with a
`schedule` trigger must call it, and `pipeline/tests/test_repo.py` fails when one does not.

## Versions

Every tool and library is pinned to an exact version, and each version lives in one file. The
`engines` field in `package.json` is a floor that matches `.node-version`, and Renovate leaves it
alone.

| What                                                     | File                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| Python                                                   | `pipeline/.python-version`                              |
| Node                                                     | `.node-version`                                         |
| uv                                                       | `pipeline/uv.toml`                                      |
| The pipeline's Python packages                           | `pipeline/pyproject.toml`, locked in `pipeline/uv.lock` |
| npm packages                                             | `package.json`, locked in `package-lock.json`           |
| GitHub Actions                                           | the commit SHA in each `uses:`                          |
| Runner image                                             | `ubuntu-24.04` in each `runs-on:`                       |
| gitleaks, with its SHA-256                               | `.github/workflows/secrets.yml`                         |
| zizmor, actionlint and shellcheck, each with its SHA-256 | `.github/workflows/workflow-lint.yml`                   |

The last two rows are raised by hand, because a raise needs the new hash. The versions in use are:

| Tool       | Version | SHA-256 (Linux x86-64 release archive)                             |
| ---------- | ------- | ------------------------------------------------------------------ |
| gitleaks   | 8.24.3  | `9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c` |
| zizmor     | 1.30.1  | `e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a` |
| actionlint | 1.7.12  | `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` |
| shellcheck | 0.11.0  | `b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6` |

An upgrade is a pull request of its own. Renovate (`renovate.json`) raises every version in the
first table except the last two rows, in the first week of each month, to exact versions only.
It opens one pull request per group and puts each major raise in a pull request of its own. The
groups are the Actions, the runner image, the pipeline's packages and the npm packages. Python,
Node and uv each get their own. Security fixes come as soon as the GitHub advisories or the OSV
database name them. Check a change to `renovate.json` with
`npx --yes --package renovate@44.221.4 -- renovate-config-validator --strict`.

## Reporting problems

Open an issue with one of the templates: a bug report, a data problem or a feature request. A
figure that differs from the source is a data problem, and [`docs/CORRECTIONS.md`](docs/CORRECTIONS.md)
says how it is handled. Accessibility barriers are reported as
[`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md#report-a-barrier) describes. Security reports go
through [SECURITY.md](SECURITY.md) and never into a public issue.

## Licences

The code and the data carry separate licences. [LICENSE](LICENSE) covers the code and
[LICENSE-DATA.md](LICENSE-DATA.md) covers the data. By contributing code you agree that it is
released under the code licence.
