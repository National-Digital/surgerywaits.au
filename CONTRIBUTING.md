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
npm run lint            # ESLint, which also lints CSS and Astro style blocks, no warnings, every disable needs a reason
npm run format:check    # Prettier
npm run typecheck       # astro check on the site, tsc on the Worker, the scripts and the lint rules
npm run knip            # unused files, exports and dependencies
npm test                # vitest, without the browser proofs
BUILT_PAGES=1 npm test  # also checks the built pages, after npm run build
BUILD_TWICE=1 npm test  # also builds again and compares every file byte for byte, after npm run build
A11Y_TEST=1 npx vitest run scripts/a11y.test.ts   # the accessibility proofs, which need Chromium
A11Y_TEST=1 npx vitest run scripts/layout.test.ts # the header proof, which needs Chromium and npm run build
npm run build           # astro build; reads the dist named by SURGERYWAITS_DIST
npm run build:preview   # the same build plus the /dev/primitives/ page, written to site/dist-preview
npm run a11y -- site/dist / /404.html   # the same checks on the built home and 404 pages
npm run a11y            # accessibility checks on their fixture pages (npx playwright install chromium first)
npm run a11y -- site/dist-preview /dev/primitives/   # the same checks on the preview page, after build:preview
npm run html -- site/dist    # the W3C Nu Html Checker over the built pages, after npm run build; needs Java 21 (JAVA names the binary)
npm run links -- site/dist   # internal links, assets and fragments on the built pages, after npm run build
npm run weight -- site/dist  # page and script weight against scripts/page-weight-budget.json, after npm run build
HTML_TEST=1 npx vitest run scripts/html.test.ts   # proves the HTML gate fails a bad page; needs Java
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

### The dist the site reads

The site reads the pipeline's dist through `site/src/lib/dist.ts`. The variable `SURGERYWAITS_DIST`
names the directory, as an absolute path. It has no default, so a published build cannot read a
fixture dist by accident. Every file the site loads is validated against its schema in `contract/`
with Ajv, which is pinned exactly, and a file that breaks its schema or sits where the contract
describes nothing stops the build. The pipeline has already checked each file, so the site's check
is the second proof that both halves agree.

The site's tests and the preview page use a small dist built from the pipeline's fixtures. It has
about 190 files and builds in seconds, the same bytes every time, and it is never committed. From
`pipeline/`:

```
uv run python tests/fixture_dist.py dist-fixture
export SURGERYWAITS_DIST="$PWD/dist-fixture"
```

`npm test` falls back to that folder when the variable is unset, so a bare run works after the
first command. To read the real dist instead, run `uv run python -m surgerywaits.pull` and
`uv run python -m surgerywaits.build` from `pipeline/`, then point the variable at the `dist` folder in `pipeline/`.
The `Worker build` and `Accessibility` jobs build the site from the fixture dist. The `Data checks` job also
builds the site from the real dist and runs the built-page tests on it, because that is the dist the
published site reads.

The `/dev/primitives/` page renders each state of the figure, the stat tile and the data table from the fixture
dist. `npm run build:preview` adds it through an Astro integration and writes the result to its own
folder, so the published build holds no `dev/` route, and `built-pages.test.ts` checks that. The
page is marked noindex. Component tests render through Astro's container API
([reference](https://docs.astro.build/en/reference/container-reference/)), and Vitest runs them with
Astro's Vite config. A test stand-in for `astro:content` serves the same YAML files, because Astro
fills its content store only during a build.

### Styles and the font

CSS lives in `site/src/styles/`, one folder for each ITCSS layer, and component styles sit in a
`<style>` block of the `.astro` file ([D18](docs/adr/0001-architecture-decision-register.md)).
`npm run lint` checks class names, tokens, breakpoints, layers and selectors. The local rules
are `eslint/rules/bem-class-name.ts`, `eslint/rules/layer-declared.ts`, `eslint/rules/token-values.ts`
and `eslint/rules/breakpoint-scale.ts`. A new colour pair goes in the pair lists of
`site/src/styles/contrast.test.ts`, which holds every text pair to 7:1 in both colour schemes. The
test also collects each `color` and `background` token pair a rule sets in the stylesheets and
fails on a pair the lists do not cover. `color-mix()` of tokens may be used anywhere, while
`light-dark()` and `color()` belong in the settings layer. The layer order is declared only in
`site/src/styles/layers.css`, and the build job checks that the built CSS opens its layers in that order.

The Newsreader font in `site/public/fonts/` comes from `scripts/fonts.sh`, which downloads a pinned
upstream commit, checks its SHA-256 and rebuilds the file. Run it by hand with `fonttools` and
`brotli` installed. No CI job or build step downloads anything. The font is not preloaded on purpose: `font-display: swap`
shows text in the fallback face at once, and a preload would spend early bandwidth on a font that text does not wait for.

### Pulling the pinned data

`data/manifest.json` pins each publicdata.au dated version by sha256, and `contract/manifest.schema.json`
defines it. To download and verify every file by hand, run this from `pipeline/`:

```
uv run python -m surgerywaits.pull
```

Each file lands in `pipeline/.downloads/<sha256>`, which git ignores. A file already there with the
right hash is not fetched again. The pull retries transport errors and 5xx responses a few times,
then stops. It stops at once on a 4xx or a hash that differs from the pin, and it keeps nothing
from a failed download. The tests never use the network.

### Checking the dist against the previous site's data

`pipeline/scripts/parity.py` compares a built dist with the previous site's built data directory.
It is a hand-run tool. CI does not run it, because that directory is not in this repository. Build
the dist first, then run this from `pipeline/`:

```
uv run python -m surgerywaits.pull
uv run python -m surgerywaits.build
uv run python scripts/parity.py dist <the previous site's built data directory> -o /tmp/parity.json
```

The script prints a short summary and, with `-o`, writes a deterministic JSON report that lists every
difference. It maps the old hospital codes, procedure and urgency identifiers, periods and roles
onto the new ones, then compares each figure, the ranks in the newest common period, the nearby
meshes and the suburb centres. A difference is marked as explained when the newer release accounts
for it, as a new period or a revision in a period both releases carry, and as unexplained otherwise.
Keep the report out of the repository.

### Git hooks

`git config core.hooksPath .githooks` turns on three hooks.

- `prepare-commit-msg` adds the `Signed-off-by` trailer when it is missing.
- `pre-commit` runs ESLint and Prettier on the staged site files and ruff on the staged Python
  files. It runs shellcheck on staged `.githooks/*` and `*.sh` files. When files under `.github/`
  are staged it also runs actionlint with shellcheck, and zizmor. A tool that is not installed
  fails the commit with a message naming it.
- `pre-push` runs `typecheck`, `knip`, `vitest`, pyright and pytest.

Skip a hook once with `--no-verify`. CI runs the same checks on every pull request.

## Writing copy

Every word a reader sees lives in YAML under `site/content/` ([ADR 0001](docs/adr/0001-architecture-decision-register.md), D10).
`site/src/lib/content-schema.ts` holds one strict Zod schema for each file, and `site/src/content.config.ts`
loads them as Astro content collections. Components read them through `site/src/lib/content.ts`, and
`label('key')` accepts only a key that `labels.yaml` defines.

- Write to the Australian Government Style Manual: plain, active, sentence-case headings.
- `terms.yaml` lists each preferred term and the terms it replaces. A test fails on a replaced term in
  any content file or built page. A methodology page that quotes a source verbatim lists the page,
  the term and the reason under `quotes`.
- The `no-literal-text` rule in the site ESLint plugin fails on text in `.astro` templates and
  frontmatter. That covers JSX text, string literals in expressions, every attribute outside a short
  non-copy list (class, href, id, lang and similar, in the rule), and `set:html` and `set:text`. Frontmatter
  strings pass only as imports, object keys and the key argument of `label` or `getPage`.
  `eslint/fixtures/text-*.astro` prove the rule.
- `quotes` in `terms.yaml` name a page slug, such as `methodology`, which is also the built page's path.
- A change to the text of a policy page (privacy, terms, accessibility or corrections) sets its `updated` date
  to the day of the change.

## Making a change

1. Branch from `main`.
2. Make the change, and keep to one concern. An unrelated fix found on the way gets its own pull
   request.
3. Open a pull request. The template asks what changed, why, and how you checked it. It also asks
   for a Docs line: the library, its version and the official documentation page you followed.
   Name anything a maintainer must do beyond merging.

## Writing tests

[ADR 0001](docs/adr/0001-architecture-decision-register.md) (decision D28) sets these rules.

- **Three runners.** Use pytest for the pipeline, Vitest for unit, contract and gate tests, and
  Playwright for work that needs a browser.
- **A gate ships with a fixture built to fail it.** A check that has only been seen to pass proves
  nothing. Add the smallest input that has the defect, and a test that asserts the gate reports it.
  The accessibility gate keeps one page per check in `scripts/a11y-fixtures/fail/`, a clean page in
  `scripts/a11y-fixtures/pass/`, and `scripts/a11y.test.ts` proves each check fires on its page.
  `pipeline/tests/test_repo.py` follows the same pattern: each check is a function over text, a
  `*_fixture_*_is_caught` test feeds it a bad workflow, and a second test runs it over the real
  files. `pipeline/tests/test_testing_rules.py` does the same for the rules in this section.
- **A bug fix adds a test that fails without the fix.** Write the test first, watch it fail, then
  fix the code.
- **Tests never touch the network.** Read data from `pipeline/tests/fixtures` and use a fixed clock.
  `pipeline/tests/conftest.py` makes pytest raise on any connection, send or name lookup except to
  localhost. The guard covers pytest only. Subprocesses, C extensions, calls made straight to
  `_socket` and functions imported before the guard starts are out of its reach.
- **Tests assert specific facts.** Assert the value, the row or the sentence that must appear. Do
  not commit HTML snapshot files, `__snapshots__` or `*-snapshots` directories, `toMatch*Snapshot`
  calls or `toHaveScreenshot` calls.
- **There is no coverage percentage gate.** A number goes up when tests are written to raise it.
  Do not add coverage thresholds to Vitest or `fail_under` to pytest.

`pipeline/tests/test_testing_rules.py` fails the build on a tracked snapshot file, a snapshot
matcher in a TypeScript test and a coverage gate. It also proves that the pytest network guard
refuses a remote connection, send or lookup.

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

| Check                           | What it does                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Check sign-off                  | Confirms every commit has a `Signed-off-by` line.                                                                                               |
| Check title                     | Confirms the pull request title is a Conventional Commit.                                                                                       |
| Secret scan (gitleaks)          | Scans the full history for credentials.                                                                                                         |
| Workflow lint                   | Lints the workflow files under `.github/workflows/` and every shell file.                                                                       |
| Review dependency changes       | Fails on a new dependency with a known high or critical vulnerability.                                                                          |
| Analyze (actions)               | Runs CodeQL static analysis on the workflows.                                                                                                   |
| Analyze (javascript-typescript) | Runs CodeQL static analysis on the TypeScript and JavaScript.                                                                                   |
| Analyze (python)                | Runs CodeQL static analysis on the Python.                                                                                                      |
| Site checks                     | Runs ESLint, Prettier, `astro check` and the TypeScript compiler, knip and vitest on the fixture dist.                                          |
| Worker build                    | Builds the site, runs the HTML and link gates, checks the Worker types are current and runs `wrangler deploy --dry-run`.                        |
| Pipeline checks                 | Runs ruff, pyright and pytest on the pipeline.                                                                                                  |
| Data checks                     | Pulls the pinned publicdata.au files, runs the whole pipeline suite with no unplanned skips, and runs the HTML and link gates on the real site. |
| Accessibility                   | Proves each check fires on a page built to fail it, then audits the preview page, at two widths, light and dark.                                |
| Repository tests                | Checks every workflow against the repository's rules, such as pinned actions and least-privilege permissions.                                   |

More checks will join this list as the pipeline and the site are built, and each is added here
when it starts to run.

### How CI runs

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main` with six jobs
whose names are stable enough to require as status checks.

- `Site checks` runs `npm ci`, then lint, format check, typecheck and knip. It builds the fixture dist
  with `uv`, sets `SURGERYWAITS_DIST` to it and runs vitest.
- `Worker build` runs `npm ci`, `astro build`, the page and script weight check (`npm run weight`), the `wrangler types --check` freshness check and
  `wrangler deploy --dry-run` into a temporary directory. It uses no Cloudflare credential or
  account identifier, and nothing is deployed. The script budget can never be set above 44,900
  bytes.
- `Pipeline checks` installs the `uv` version in `pipeline/uv.toml`, runs `uv sync --locked`, then
  ruff, pyright and pytest. It leaves out `tests/test_repo.py`, `tests/test_docs.py` and
  `tests/test_testing_rules.py`, because the next job runs them.
- `Data checks` restores the pipeline's download cache from the Actions cache, keyed on the hash of
  `data/manifest.json`, then runs `uv run python -m surgerywaits.pull`, which verifies every
  sha256 and fetches only from publicdata.au. About 140 MB downloads on a cache miss. It then runs
  the whole pytest suite with `SURGERYWAITS_REQUIRE_DATA=1`, which turns any skip whose reason
  does not start with `planned:` into a failure, so a missing pinned file cannot hide. Set the
  same variable locally after a pull to see the same result. It then builds the site from the real
  dist, runs the HTML, link and weight gates, installs Chromium and prints the compare sheet on the
  real figures, which must fit one page.
- `Accessibility` installs Chromium with `npx playwright install --with-deps chromium`, then runs
  `npm run a11y` and the tests in `scripts/a11y.test.ts`. The first proves each accessibility
  check fires on its fixture page in `scripts/a11y-fixtures/`. The job also builds the fixture dist
  and the preview build, and holds the `/dev/primitives/` page and the compare page in three states
  (empty, with suggestions listed, with results shown) to the same checks. It also drives the built
  compare tool in Chromium with `scripts/tool.test.ts`. See
  [`accessibility.yaml`](site/content/pages/accessibility.yaml).
- `Repository tests` runs `pipeline/tests/test_repo.py`, `pipeline/tests/test_docs.py` and
  `pipeline/tests/test_testing_rules.py`. The first reads every workflow and checks
  that jobs with side effects are guarded by the repository name, that no pull request workflow
  runs Lighthouse or PageSpeed Insights, that `pull_request_target` is unused, that every action
  is pinned to a commit SHA with a version comment, that each workflow declares top-level
  `permissions:`, that each job runs on a named image, and that every scheduled workflow reports
  its failures through the reusable workflow. The second fails when a document links to a missing
  file or heading, names a missing path or npm script, lists a check that no workflow defines, or
  cites a test, pending test or CI job in `docs/ARCHITECTURE.md` that does not exist. The third
  fails on snapshot files, snapshot matchers and coverage gates, and proves the network guard.

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
figure that differs from the source is a data problem, and [`corrections.yaml`](site/content/pages/corrections.yaml)
says how it is handled, and the site serves it at `/corrections/`. Accessibility barriers are reported as
`/accessibility/` describes. Security reports go
through [SECURITY.md](SECURITY.md) and never into a public issue.

## Licences

The code and the data carry separate licences. [LICENSE](LICENSE) covers the code and
[LICENSE-DATA.md](LICENSE-DATA.md) covers the data. By contributing code you agree that it is
released under the code licence.
