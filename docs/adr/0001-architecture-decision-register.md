# 0001: Architecture decision register

- Status: Accepted
- Date: 2026-11-06

## Context

surgerywaits.au is rebuilt as a public repository and is meant as a worked example of building a
site on [publicdata.au](https://publicdata.au/). The decisions that shape the build are made before
most of the code exists. Writing them in one place lets a contributor read what was chosen and why
before changing it.

## Decision

The register below holds twenty-eight decisions, D1 to D28. Each has the decision and the reason for
it. A part that is not built yet is marked as planned, and the decision still stands. A later record
supersedes or refines a decision when it changes.

## The register

### D1: The repository is public and lives under National-Digital

The code is in the public repository `National-Digital/surgerywaits.au`, which takes the site's
domain name as its name, as the publicdata.au repository does. The `main` branch has its own
protection ruleset, modelled on publicdata.au's.

Why: the site shows public data and makes claims about it. A public repository lets anyone read how
each figure is produced and check it. The same layout as publicdata.au lets the repository serve as
a worked example.

### D2: publicdata.au's stable API is the only data source

The build reads immutable dated version files at `/d/<slug>/v/<date>/data.parquet` on publicdata.au.
Each file is verified against a sha256 pinned in a manifest, on every download. A refresh finds new
versions through `/api/v1/datasets/<slug>/versions`. Each emptied cell's publisher code comes from
the `markers` column. The credit line uses the citation that publicdata.au publishes with each
version, with the dataset title, publisher and version page from the same metadata. The build checks
the manifest's copy of each against the file's own metadata.

The build has no fallback to any other source. It does not fetch from AIHW, Queensland Health or the
ABS directly.

Why: a dated, hashed file gives the same bytes on every build, so a figure on the site traces to one
version of one dataset. A second source would need its own parser, its own licence check and its own
account of what changed, and two sources can disagree without either being wrong. Using one source
also shows how a site builds on publicdata.au.

### D3: Three reasons explain a suppressed cell

A suppressed cell in a hospital's own figures is shown as "not published" with one of three
reasons, taken from the publisher code in the `markers` column:

- "<5": too few patients.
- "-": no patients reported.
- "NP": not published by AIHW.

The methodology page, once built, says that "NP" covers more than one reason AIHW gives. A
suppressed cell is never shown as 0, never left blank and never ranked.

The `markers` column also holds "Not peered", which appears only in place of the peer-group
columns. AIHW does not define that code. It is not one of the three reasons. It applies only to
the peer-group figures, and the site shows it as "not published: no peer group comparison"
without giving it a meaning of its own. A code the pipeline does not know will fail the build.

The Queensland tables have no `markers` column. They list the suppressed columns in a `suppressed`
field. A column that field names is "not published" with the reason "Queensland Health gave no
figure". A null in the year-on-year change column that the field does not name is "not reported".
This rests on the register declaring that column nullable. Any other null that the field does not
name fails the build.

Why: each code means something different to a reader. A zero reads as "no patients waited", which is
false for "<5" and "NP". Naming the reason lets a reader judge whether a gap is small, absent or
withheld.

### D4: The data build is Python 3.13, checked strictly

`pipeline/` is a Python 3.13 package managed with uv. It is checked with ruff, pyright in strict
mode and pytest. Parquet is read with pyarrow, pinned to an exact version.

Why: Python has mature Parquet and data-frame libraries. Strict type checking catches a column that
changes type before it reaches a published figure, and pinned readers keep the output reproducible
([D2][d2]).

### D5: JSON Schemas in `contract/` define every output file

`contract/` holds a JSON Schema for each file the pipeline writes. The pipeline writes to the
schemas, the site validates against them, and the OpenAPI description is generated from the same
schemas.

Why: a schema file, a type definition and an API description written by hand drift apart. One source
for all three means a change to an output file is a change to one schema, and a check fails when
either half disagrees with it.

### D6: The site is Astro with strict TypeScript

`site/` is an Astro project with static output and TypeScript in strict mode. The compare tool is
one vanilla TypeScript module that Astro loads as a script. It uses no framework. The tool is built.

Why: Astro renders each page to HTML at build time, so a static page needs no JavaScript to read. A
single dependency-free module keeps the one interactive part small enough to audit for privacy
([D8][d8]).

### D7: A Cloudflare Worker with static assets hosts the site

One Cloudflare Worker serves the built site as static assets. It also holds the response headers,
redirects, content negotiation and the MCP route ([D9][d9]).

There are no per-pull-request preview deployments. Checks run in CI. Production deploys only from
`main`, through a protected environment. The deploy workflow, the environment's token and the
account identifier are added when the site is ready to ship, and are planned. Until then CI builds
the Worker and runs `wrangler deploy --dry-run`, which needs no Cloudflare credentials. If previews
are wanted after that, they use a hostname on the site's own domain with `noindex`, and never a
`workers.dev` hostname. The Worker's configuration turns `workers_dev` and `preview_urls` off, and a
repository test fails when either is missing or on.

Why: a Worker serves static assets and runs code in one deployment. Headers, redirects, content
negotiation and the MCP route then live in one deployment as code that tests can run. Without
previews, no Cloudflare credential sits in the repository until the site is ready to ship.

### D8: Analytics count page views and nothing else

The site counts page views with Cloudflare Web Analytics. The repository sets no cookie and the
Worker drops any `Set-Cookie`. The count relies on Cloudflare Web Analytics, which Cloudflare
[describes as using no cookies or other client-side state for analytics](https://blog.cloudflare.com/privacy-first-web-analytics/); the tests cannot observe the beacon, which Cloudflare adds at the edge.
Nothing a person types is sent anywhere, and the compare tool fetches only its own `/tool/` files.
The beacon and report hosts are the only other hosts in the Content-Security-Policy, and the
privacy check in CI allows exactly those.

Why: the site needs to know which pages are read so it can improve them. A page-view count that sets
no cookie answers that without identifying anyone. The compare tool stays stateless, as
the Privacy rule in `docs/ARCHITECTURE.md` sets out.

### D9: MCP is a route in the same Worker

The MCP server is the `/mcp` route of the Worker in [D7][d7]. It reads the built JSON through the
Worker's assets binding and keeps the tool names that clients already use. The route is built and
speaks the 2026-07-28 revision of the protocol.

Why: one deploy carries the site and the MCP server, so the two cannot show different data. Reading
built files means the route runs no query engine and has nothing to keep in step with the pipeline.

### D10: Every word a person wrote lives in YAML under `site/content/`

Copy lives in YAML files under `site/content/`, validated by Zod collections with `.strict()`. Figures,
names and dates come from the output files ([D5][d5]) and never from YAML.

- Each static page (guides, methodology, legal, FAQ, about and the 404 page) is one YAML file.
- Each generated page template (hospital, surgery, pair, state and the rest) has one YAML file for
  its headings, explanations and the sentences around each figure. A sentence names its slots, such
  as `{hospital}` or `{median_days}`, and a test fails when a slot is missing or unknown.
- Button text, labels, `alt`, `aria-label` and `title` values come from `site/content/labels.yaml`.
- A lint rule fails on literal user-visible text in components, layouts and the compare tool's
  module. The tool reads its strings from a JSON file built from the same YAML.
- The Markdown twins and the JSON-LD descriptions use the same strings, so each sentence is written
  once.

Why: copy kept apart from components can be reviewed and checked for terminology and readability
without reading code. The same text reaches the HTML page, its Markdown twin and the structured data
without copies drifting.

### D11: One entity file names the publisher

A single site entity file holds the publisher's details. The footer and the legal pages read the
line "Built and operated by National Digital, Burleigh Heads, Queensland", with links to
nationaldigital.com.au and its contact page. The site prints no ACN, no ABN and no "Pty Ltd". The
terms and privacy pages follow the structure of publicdata.au's. The entity file and the footer are built and the
legal pages are planned.

Why: one file means the publisher is named the same way on every page. The line states who runs the
site and where, and gives a reader a way to make contact.

### D12: Toolchain versions are pinned and Renovate raises updates

Node is pinned in `.node-version` and `engines`. `.npmrc` sets `save-exact` and `engine-strict`.
Python is pinned in `pipeline/.python-version` and uv in `pipeline/uv.toml`. `renovate.json` raises
the updates:

- It extends `config:recommended` and `:gitSignOff`, so each Renovate commit passes the sign-off
  check. It turns off the dependency dashboard and the preset that changes the commit prefix.
- It runs in Brisbane time during the first seven days of each month (`* * 1-7 * *`).
- It raises security fixes as soon as GitHub's advisories or the OSV database name them
  (`osvVulnerabilityAlerts`). It sets no hourly limit on pull requests.
- It pins every version exactly (`rangeStrategy: pin`). Commits use `build` as the type, and `ci`
  for actions and the runner image.
- It manages pyenv, nodenv, GitHub Actions, `pyproject.toml` (pep621) and npm, plus a regex manager
  that reads uv's version from `uv.toml`.
- It opens one pull request for each group: actions (with digests pinned), runner image, pipeline
  packages and npm. Each major update gets its own pull request. It leaves `engines` alone.

Gitleaks, zizmor, actionlint and shellcheck are raised by hand, each with its SHA-256, as
`CONTRIBUTING.md` describes.

Why: pinned versions make builds reproducible ([D2][d2]). A monthly window and grouped pull requests
keep the review load small, and the vulnerability setting means a security fix does not wait for the
window.

### D13: Code, text and data have separate licences

The code is under AGPL-3.0-or-later. The site's own text is under CC BY 4.0. Each source keeps its
publisher's licence, as `LICENSE-DATA.md` records. `BRAND.md` covers the names and marks.

Why: the three kinds of material have different owners and different needs. Keeping them separate
means a grant over the code or the text gives no rights over a publisher's data. The same split
makes the repository a clear example for others who build on publicdata.au.

### D14: Each required check is named in the ruleset

The `main` ruleset requires each check by name. These checks exist today:

- Check title
- Check sign-off
- Secret scan (gitleaks)
- Review dependency changes
- Analyze (actions), Analyze (javascript-typescript) and Analyze (python)
- Workflow lint
- Site checks
- Pipeline checks
- Repository tests

Later checks join the ruleset as each lands. They are planned: determinism for the pipeline and the
site, HTML validity ([D17][d17]), accessibility, extractability, the content and format gates, and
deploy. A single aggregate check is not used.

Why: a named check says which rule failed, and a reviewer sees the cause in the check list. An
aggregate hides which of its parts failed and lets a skipped part count as a pass.

### D15: Failure alerts go through GitHub only

A failed scheduled run notifies through GitHub's own Actions notifications. Each scheduled job also
keeps one open issue while it fails. The workflow opens the issue on the first failure, updates it
on each later failure and closes it on the next success. The issue automation is planned.

Why: the people who maintain the site already watch GitHub. One issue for each failing job gives a
single place to see the state and avoids a new issue on every run.

### D16: Lighthouse runs on demand and never gates a pull request

Two workflows measure performance. `psi.yml` checks production through the PageSpeed Insights API.
`lighthouse.yml` runs a pinned Lighthouse against a URL. Both run only on `workflow_dispatch`.
Neither runs on a schedule, on `pull_request` or on `merge_group`, and neither is a required check.
Both workflows are planned. A repository test fails if any workflow that runs Lighthouse or
PageSpeed Insights has a trigger other than `workflow_dispatch`.

Why: scores from a shared runner vary from run to run, so a pull request can fail for a reason it
did not cause. Running on demand against production measures what visitors receive.

### D17: The whole build is checked by the W3C Nu Html Checker

The W3C Nu Html Checker runs with `--Werror` over every file in the built output. An error or a
warning fails the run. The checker's version is pinned exactly, and each line in its filter file
carries a comment giving the reason. The checker needs Java 21, installed through a pinned setup
action, and the `vnu-jar` install script is turned off. The command skips non-HTML files and runs
over the build output. The filter file starts empty. This decision is planned and the check is not
built yet.

Why: the checker tests pages against the HTML standard itself. Running it over the whole output
catches an invalid page that a sample would miss, and this supports the accessibility floor in
the Accessibility rule in `docs/ARCHITECTURE.md`.

### D18: CSS follows ITCSS layers and BEM names

Styles are plain CSS with no Sass, and use native nesting, custom properties, `@layer`,
`color-mix()` and range media queries. One `@layer` order is declared once: print, settings,
generic, elements, objects, components, utilities. Class names follow `.o-object`,
`.c-block__element--modifier` and `.u-utility`, with `is-` and `has-` for state and `js-` for script
hooks. Astro components use scoped styles inside the components layer, except DataTable, which uses
`<style is:global>` because scoped styles add an attribute to every cell and that made the largest page
more than twice the size. `!important` appears only in utilities and print.

Lint rules from `@eslint/css`, with a local plugin, check the convention: a class-name pattern,
spacing, colour and timing taken from tokens only, a breakpoint scale from the site's tokens,
required layers, relative font units, no ID selectors and at most three classes in a selector, and
Baseline compatibility.

Why: a named methodology that a lint rule can check holds across contributors. Layers make the
cascade order explicit, and a fixed naming scheme tells a reader what a class is for.

### D19: Pages ship no client JavaScript by default

Every page is complete and usable with scripts off. The header shows the site navigation inline at every width, with no menu toggle. The compare tool is the only
script: one vanilla TypeScript module loaded as `<script type="module">` from the site itself, with
no framework and no islands runtime. Scripts find their elements through `js-` classes or `data-`
attributes and never through styling classes, so a CSS rename cannot break behaviour. The tool keeps
no storage, URL state or history, fetches only from its own site and sends nothing a person types
([D8][d8]). A weight check holds the module to a set byte budget and fails when it grows past it.
Browser support follows Baseline "widely available", and newer APIs sit behind a feature check.

Why: this records how the site works, so that adding a framework or a second script needs a new
record. Pages that work without scripts are easier to make accessible and to read for tools that do
not run scripts.

### D20: Types are strict everywhere

The site uses TypeScript `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax` and
`isolatedModules`. `astro check` is the type check for the site, and `tsc --noEmit` checks the
Worker. ESLint uses `typescript-eslint` with `strictTypeChecked` and `stylisticTypeChecked`,
`eslint-plugin-astro`, no `any`, no non-null assertions, and knip for unused exports. Zod schemas use `.strict()` and never `z.any()`. A lint rule is never disabled inline
without a one-line reason, and the `eslint-comments` plugin's `require-description` rule enforces
this. ESLint loads `eslint.config.ts` through `jiti`. The Zod part is planned.

Every script is TypeScript, so no `.js` or `.mjs` file is written. The Worker's bindings are typed
by `wrangler types`, and CI fails when the generated file is out of date. Shellcheck runs over
workflow scripts through actionlint, and over `.githooks/*` and every `*.sh` file in the
`Workflow lint` job and the pre-commit hook. The Python side keeps pyright in strict mode and ruff
([D4][d4]).

Why: strict flags left to each author vary from file to file. A fixed list makes the type check the
same for every contributor and catches a missing array element or an unchecked optional before it
reaches a page.

### D21: Previews and deploys wait until the site is ready to ship

No preview and no deploy workflow exists before go-live. CI builds the Worker and checks it with
`wrangler deploy --dry-run`. The deploy workflow, the production environment's token and the
account identifier are added when the site is ready to ship. Details are in [D7][d7].

Why: keeping every Cloudflare credential out of the repository until it is needed removes a source
of leaks. A dry run checks the Worker's configuration and size without one.

### D22: The repository follows Astro's project layout

The layout follows Astro's documented structure, read from the current Astro documentation when each
part is written:

- `src/` holds `pages/`, `layouts/`, `components/`, `lib/` and `styles/`. `styles/` has one folder
  for each ITCSS layer ([D18][d18]).
- `site/content/` holds every YAML file ([D10][d10]), read by Astro's `glob` loader.
- `public/` holds static files served as they are, such as the font and `security.txt`.
- `worker/` holds the one Worker: assets, headers, redirects, content negotiation and the MCP route
  ([D7][d7], [D9][d9]).
- `pipeline/` holds the Python package, with its own `src/` and `tests/`.
- `contract/` holds the JSON Schemas ([D5][d5]) and `data/` holds the manifest.
- `scripts/` holds one TypeScript script for each package script ([D20][d20]).
- `tests/` holds the Vitest and Playwright tests ([D28][d28]).
- `docs/` is set out in [D24][d24].

The root holds the files GitHub and the licences expect, and configuration files. Parts of this
layout that are not built are planned.

Why: a layout that any Astro developer recognises lowers the cost of a first contribution. One
folder for each job makes it plain where a change belongs.

### D23: Library choices follow the current official documentation

Each library, framework and platform choice follows the official documentation current when the pull
request is written. The pull request names the version and the documentation page used, in a "Docs"
line of the pull request template. The template carries the "Docs" line.

Why: tooling changes quickly, and a cited page lets a reviewer check the pattern against its source.

### D24: Documentation has one place for each audience

- `README.md` is for people: what the site is, how to run it, how to contribute, and links to the
  decision records.
- The files GitHub recognises stay at the root: contributing, security, code of conduct, governance,
  support, citation, code owners, the licences, third-party notices and brand.
- `AGENTS.md` is for agents: a short lookup table of where to look and what must hold, which never
  restates code or a schema.
- `docs/` holds three things: `ARCHITECTURE.md`, `adr/` and `refs/` (planned), where
  machine-readable policies such as the HTML checker's filter file live. Each rule in
  `ARCHITECTURE.md` is one line naming the test or check that enforces it, and the docs-drift test
  fails when a named pytest function, vitest title or CI job does not exist. The rule is in place.
  A rule may name a pending test until the test lands.
- The toolchain guide now lives in `CONTRIBUTING.md`, and `README.md` and `AGENTS.md` follow this
  split.
- The corrections policy and its log, and the accessibility statement, are planned to move into the
  site's own content. They are served at `/corrections/` and `/accessibility/` and each has a
  Markdown twin. The data-problem issue template links the corrections page. Until the site has
  pages, `docs/CORRECTIONS.md` and `docs/ACCESSIBILITY.md` stay in `docs/` and move then.

Why: readers find governance files where GitHub shows them, and each policy is written once. A
corrections log kept in the repository and again on the site would drift apart.

### D25: Copy follows the Australian Government Style Manual

The Australian Government Style Manual is the style reference for every YAML string. Copy uses plain
declarative sentences in the active voice, sentence-case headings, and no superlative without a
number beside it.

The terminology rule in `docs/ARCHITECTURE.md` becomes a terms file in `site/content/` that lists each
preferred term and the terms it replaces, and a test fails on a replaced term in any copy.
Readability is measured on every prose field, with slots filled by sample values. Guides and
template copy must score Flesch-Kincaid grade 8 or lower. Methodology and legal pages must score
grade 12 or lower. An exception is listed in a policy file with its reason. The readability library
is pinned exactly. The terms file is built and the readability test is planned.

Why: many readers are older patients reading about their own surgery. A measured floor keeps the
copy plain whoever writes it.

### D26: One module formats every figure and date

`src/lib/format.ts` formats every figure and date the site shows, using `Intl` with the `en-AU`
locale. Dates follow the Style Manual's day-month-year form, such as "2 November 2026". The output
files hold ISO dates, and the module formats them in UTC so the build machine's time zone cannot
shift a day. Numbers group thousands with a comma, and units such as "1 day" and "42 days" use
`Intl.PluralRules`. A lint rule bans `toLocaleString`, `toLocaleDateString`, `new Intl.*` and `Date`
getters outside that module, and the compare tool bundles the same module. The pipeline writes ISO
dates and raw numbers only, and never display strings. The pinned Node build carries full ICU, and
the site determinism check proves the output is byte-identical across machines. This is planned.

Why: formatting in many places lets dates and plurals drift between pages. One module is testable
and gives the same result on every machine.

### D27: Python lint is `ruff` with every rule selected

`ruff` runs with `select = ["ALL"]` and `ruff format` as the formatter, both in CI and the
pre-commit hook. The ignore list in `pyproject.toml` is short and each entry has a one-line
reason: the docstring rules, because comments and docstrings are one short line where needed;
`COM812` and `ISC001`, because they conflict with `ruff format`; and `S101` in tests only, because
pytest uses `assert`. The list also ignores `CPY`, because no file carries a copyright header and
the licence files cover the code. pyright stays in strict mode ([D4][d4]). pytest runs with
`--strict-markers`, `--strict-config` and `-W error`, with `xfail_strict = true`.

Why: selecting every rule and ignoring a few with stated reasons catches more than a short allow
list, and the same stance applies to TypeScript in [D20][d20].

### D28: Three test runners each have one job

- pytest tests the pipeline. It runs with `--strict-markers`, `--strict-config`, `-W error` and
  `xfail_strict = true`, so an unknown marker, a config typo, a warning or a stray pass fails.
- Vitest runs unit, contract and gate tests for the site, scripts and Worker. It runs today for the
  site. The Worker's tests are planned to run in Cloudflare's Vitest pool, so they use the real
  runtime.
- Playwright covers anything a browser must do: the accessibility check, print, the compare tool,
  the 390px layouts and the header navigation without scripts. Browser versions are pinned with the package.

Every check ships with a fixture built to fail it. Every bug fix adds a test that fails without the
fix. Tests never touch the network and use fixtures and a fixed clock. Tests assert specific facts,
and no HTML snapshot files are committed. No coverage percentage gates a pull request, and each
subject has its own named check ([D14][d14]). Playwright, the Worker pool and the `tests/` folder
are planned.

Why: naming the runner for each job keeps tests where they belong. Fixtures that fail on purpose
show that a check can fail, and the absence of a coverage gate avoids tests written to raise a
number.

## Alternatives considered

- **A fallback source for the data ([D2][d2]).** A fallback needs its own parsing and licence check,
  and a quiet switch to it would put figures from two origins on one page. The build fails instead,
  and the failure is the signal to fix the source.
- **Cloudflare Pages with per-pull-request previews ([D7][d7]).** Pages keeps headers and redirects
  in separate files and runs code in a separate functions layer. Previews need Cloudflare
  credentials in the repository before the site is ready.
- **A single aggregate required check ([D14][d14]).** It reports one result and hides which part
  failed.
- **Lighthouse as a required check ([D16][d16]).** Runner variance makes the result unrepeatable.

## Consequences

- A change to any decision above adds a record with the next number, as `docs/adr/README.md`
  describes.
- Checks in D14 and the deploy workflow in D7 are added to `CONTRIBUTING.md` and to the ruleset as
  each lands.
- The site depends on publicdata.au being available at build time. A build that cannot reach a
  pinned version fails and publishes nothing new.

See `docs/ARCHITECTURE.md` ("The shape", "Rules that decide the code"), `CONTRIBUTING.md`
("Checks on each pull request") and `LICENSE-DATA.md`.

[d2]: #d2-publicdataaus-stable-api-is-the-only-data-source
[d5]: #d5-json-schemas-in-contract-define-every-output-file
[d7]: #d7-a-cloudflare-worker-with-static-assets-hosts-the-site
[d8]: #d8-analytics-count-page-views-and-nothing-else
[d9]: #d9-mcp-is-a-route-in-the-same-worker
[d4]: #d4-the-data-build-is-python-313-checked-strictly
[d10]: #d10-every-word-a-person-wrote-lives-in-yaml-under-sitecontent
[d14]: #d14-each-required-check-is-named-in-the-ruleset
[d16]: #d16-lighthouse-runs-on-demand-and-never-gates-a-pull-request
[d17]: #d17-the-whole-build-is-checked-by-the-w3c-nu-html-checker
[d18]: #d18-css-follows-itcss-layers-and-bem-names
[d20]: #d20-types-are-strict-everywhere
[d24]: #d24-documentation-has-one-place-for-each-audience
[d28]: #d28-three-test-runners-each-have-one-job
