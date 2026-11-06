# 0001: Architecture decision register

- Status: Accepted
- Date: 2026-11-06

## Context

surgerywaits.au is rebuilt as a public repository and is meant as a worked example of building a
site on [publicdata.au](https://publicdata.au/). The decisions that shape the build are made before
most of the code exists. Writing them in one place lets a contributor read what was chosen and why
before changing it.

## Decision

The register below holds seventeen decisions, D1 to D17. Each has the decision and the reason for
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
Each file is verified against a sha256 pinned in a manifest. A refresh finds new versions through
`/api/v1/datasets/<slug>/versions`. Each emptied cell's publisher code comes from the `markers`
column. The credit line uses the citation that publicdata.au publishes with each version.

The build has no fallback to any other source. It does not fetch from AIHW, Queensland Health or the
ABS directly.

Why: a dated, hashed file gives the same bytes on every build, so a figure on the site traces to one
version of one dataset. A second source would need its own parser, its own licence check and its own
account of what changed, and two sources can disagree without either being wrong. Using one source
also shows how a site builds on publicdata.au.

### D3: Three reasons explain a suppressed cell

A suppressed cell is shown as "not published" with one of three reasons, taken from the publisher
code in the `markers` column:

- "<5": too few patients.
- "-": no patients reported.
- "NP": not published by AIHW.

The methodology page, once built, says that "NP" covers more than one reason AIHW gives.
A suppressed cell is
never shown as 0, never left blank and never ranked.

Why: each code means something different to a reader. A zero reads as "no patients waited", which is
false for "<5" and "NP". Naming the reason lets a reader judge whether a gap is small, absent or
withheld.

### D4: The data build is Python 3.13, checked strictly

`pipeline/` is a Python 3.13 package managed with uv. It is checked with ruff, pyright in strict
mode and pytest. Parquet is read with pyarrow or duckdb, pinned to an exact version.
The Parquet reader is planned.

Why: Python has mature Parquet and data-frame libraries. Strict type checking catches a column that
changes type before it reaches a published figure, and pinned readers keep the output reproducible
([D2][d2]).

### D5: JSON Schemas in `contract/` define every output file

`contract/` holds a JSON Schema for each file the pipeline writes. The pipeline writes to the
schemas, the site validates against them, and the OpenAPI description is generated from the same
schemas.

Why: a schema file, a type definition and an API description written by hand drift apart. One source
for all three means a change to an output file is a change to one schema, and a check fails when
either half disagrees with it. The schemas and the OpenAPI description are planned.

### D6: The site is Astro with strict TypeScript

`site/` is an Astro project with static output and TypeScript in strict mode. The compare
tool is one vanilla TypeScript module that Astro loads as a script. It uses no framework. The site
is planned.

Why: Astro renders each page to HTML at build time, so a static page needs no JavaScript to read. A
single dependency-free module keeps the one interactive part small enough to audit for privacy
([D8][d8]).

### D7: A Cloudflare Worker with static assets hosts the site

One Cloudflare Worker serves the built site as static assets. It also holds the response headers,
redirects, content negotiation and the MCP route ([D9][d9]).

There are no per-pull-request preview deployments. Checks run in CI. Production deploys only from
`main`, through a protected environment. The deploy workflow comes later and is planned.

Why: a Worker serves static assets and runs code in one deployment. Headers, redirects, content
negotiation and the MCP route then live in one deployment as code that tests can run. Without
previews, no Cloudflare credential sits in the repository until the site is ready to ship.

### D8: Analytics count page views and nothing else

The site counts page views with Cloudflare Web Analytics. The count sets no cookie. Nothing a person
types is sent anywhere. The beacon and report hosts are the only other hosts in the
Content-Security-Policy, and the privacy check in CI allows exactly those. The
Content-Security-Policy and the privacy check are planned.

Why: the site needs to know which pages are read so it can improve them. A page-view count with no
cookie answers that without identifying anyone. The compare tool stays stateless, as
`docs/ARCHITECTURE.md` rule 8 sets out.

### D9: MCP is a route in the same Worker

The MCP server is the `/mcp` route of the Worker in [D7][d7]. It reads the built JSON through the
Worker's assets binding and keeps the tool names that clients already use. The route is planned.

Why: one deploy carries the site and the MCP server, so the two cannot show different data. Reading
built files means the route runs no query engine and has nothing to keep in step with the pipeline.

### D10: Every word a person wrote lives in YAML under `content/`

Copy lives in YAML files under `content/`, validated by Zod collections with `.strict()`. Figures,
names and dates come from the output files ([D5][d5]) and never from YAML.

- Each static page (guides, methodology, legal, FAQ, about and the 404 page) is one YAML file.
- Each generated page template (hospital, surgery, pair, state and the rest) has one YAML file for
  its headings, explanations and the sentences around each figure. A sentence names its slots, such
  as `{hospital}` or `{median_days}`, and a test fails when a slot is missing or unknown.
- Button text, labels, `alt`, `aria-label` and `title` values come from `content/labels.yaml`.
- A lint rule fails on literal user-visible text in components, layouts and the compare tool's
  module. The tool reads its strings from a JSON file built from the same YAML.
- The Markdown twins and the JSON-LD descriptions use the same strings, so each sentence is written
  once.

Why: copy kept apart from components can be reviewed and checked for terminology and readability
without reading code. The same text reaches the HTML page, its Markdown twin and the structured data
without copies drifting.

The content collections are planned.

### D11: One entity file names the publisher

A single site entity file holds the publisher's details. The footer and the legal pages read the
line "Built and operated by National Digital, Burleigh Heads, Queensland", with links to
nationaldigital.com.au and its contact page. The site prints no ACN, no ABN and no "Pty Ltd". The
terms and privacy pages follow the structure of publicdata.au's. The entity file, the footer and
the legal pages are planned.

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
`docs/TOOLCHAIN.md` describes.

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

Later checks join the ruleset as each lands. A single aggregate check is not used.

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
Both workflows are planned. A repository test fails if any workflow triggered by a pull request, the
merge queue or `workflow_run` runs Lighthouse or PageSpeed Insights.

Why: scores from a shared runner vary from run to run, so a pull request can fail for a reason it
did not cause. Running on demand against production measures what visitors receive.

### D17: The whole build is checked by the W3C Nu Html Checker

The W3C Nu Html Checker runs with `--Werror` over every file in the built output. An error or a
warning fails the run. The checker's version is pinned exactly, and each line in its filter file
carries a comment giving the reason. This decision is planned and the check is not built yet.

Why: the checker tests pages against the HTML standard itself. Running it over the whole output
catches an invalid page that a sample would miss, and this supports the accessibility floor in
`docs/ARCHITECTURE.md` rule 9.

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

See `docs/ARCHITECTURE.md` ("The planned shape", "Rules that decide the code"), `CONTRIBUTING.md`
("Checks on each pull request") and `LICENSE-DATA.md`.

[d2]: #d2-publicdataaus-stable-api-is-the-only-data-source
[d5]: #d5-json-schemas-in-contract-define-every-output-file
[d7]: #d7-a-cloudflare-worker-with-static-assets-hosts-the-site
[d8]: #d8-analytics-count-page-views-and-nothing-else
[d9]: #d9-mcp-is-a-route-in-the-same-worker
[d14]: #d14-each-required-check-is-named-in-the-ruleset
[d16]: #d16-lighthouse-runs-on-demand-and-never-gates-a-pull-request
