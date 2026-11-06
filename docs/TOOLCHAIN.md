# Toolchain

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

## Checks

From the repository root:

```
npm run lint            # ESLint, typescript-eslint strict-type-checked, no warnings allowed
npm run format:check    # Prettier
npm run typecheck       # tsc
npm run knip            # unused files, exports and dependencies
npm test                # vitest
```

From `pipeline/`:

```
uv run ruff check
uv run ruff format --check
uv run pyright
uv run pytest
```

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main` with three jobs
whose names are stable enough to require as status checks.

- `Site checks` runs `npm ci`, then lint, format check, typecheck, knip and vitest.
- `Pipeline checks` installs the `uv` version in `pipeline/uv.toml`, runs `uv sync --locked`, then
  ruff, pyright and pytest, leaving out `tests/test_repo.py` and `tests/test_docs.py` because the next job runs them.
- `Repository tests` runs `pipeline/tests/test_repo.py` and `pipeline/tests/test_docs.py`. The
  second fails when a document links to a missing file or heading, names a missing path or npm
  script, or lists a check that no workflow defines. The first reads every workflow and checks
  that jobs with side effects are guarded by the repository name, that no pull request workflow
  runs Lighthouse or PageSpeed Insights, that `pull_request_target` is unused, that every action
  is pinned to a commit SHA with a version comment, that each workflow declares top-level
  `permissions:`, and that each job runs on a named image.

## Git hooks

`git config core.hooksPath .githooks` turns on three hooks.

- `prepare-commit-msg` adds the `Signed-off-by` trailer when it is missing.
- `pre-commit` runs ESLint and Prettier on the staged site files and ruff on the staged Python
  files. When files under `.github/` are staged it also runs actionlint with shellcheck, and
  zizmor. A tool that is not installed fails the commit with a message naming it.
- `pre-push` runs `typecheck`, `knip`, `vitest`, pyright and pytest.

Skip a hook once with `--no-verify`. CI runs the same checks on every pull request.

## Where each version lives

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
