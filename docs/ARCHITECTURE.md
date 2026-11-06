# Architecture

surgerywaits.au is a static site that shows public hospital planned-surgery waiting times. It takes
all its data from [publicdata.au](https://publicdata.au/) and has no other source.

## Status

This repository is being rebuilt. Each part below is marked as planned until it exists. A part
that is not yet built is described as it will be, and this page changes as each part lands.

## The planned shape

```
publicdata.au        dated, immutable data files, each with a sha256 in a manifest
      |
pipeline/            Python 3.13 data build (planned)
      |
dist                 output files, each validated against a JSON Schema in contract/ (planned)
      |
site/                Astro, static output, strict TypeScript (planned)
      |
Cloudflare Worker    serves the static assets (planned)
```

- **publicdata.au.** The build reads immutable dated version files at
  `https://publicdata.au/d/<slug>/v/<date>/data.parquet`. It checks each file against the sha256
  pinned in a manifest. A refresh finds new versions through the service's versions endpoint at
  `/api/v1/datasets/<slug>/versions`. Suppressed and empty cells arrive as nulls, and a
  `markers` column keeps the publisher's code for each emptied cell. That code gives the reason the
  site shows. The credit line uses the citation that
  publicdata.au publishes with each version.
- **`pipeline/` (planned).** A Python 3.13 package built with uv, and checked with ruff, pyright in
  strict mode and pytest. It turns the pinned files into the output files.
- **`contract/` (planned).** JSON Schemas that define every file in the output. The pipeline
  writes to them and the site reads from them.
- **`site/` (planned).** An Astro project with static output. It consumes only the pipeline's
  output.
- **Worker (planned).** A Cloudflare Worker with static assets serves the built site.

## Rules that decide the code

[ADR 0001](adr/0001-architecture-decision-register.md) records the decisions behind the shape and
the rules, and why each was made.

Checks will enforce each rule as the build lands, and until then reviewers apply them. Each check
is listed in [CONTRIBUTING.md](../CONTRIBUTING.md#checks-on-each-pull-request) when it starts to
run. The planned checks are listed as pending tests in
[`site/src/contracts/gates.test.ts`](../site/src/contracts/gates.test.ts) and
[`pipeline/tests/test_contracts.py`](../pipeline/tests/test_contracts.py). Each becomes a real test
when its part lands.

1. **Two halves with one boundary.** `pipeline/` (Python) is the data build and `site/`
   (TypeScript) is the front end. The site consumes only the pipeline's output, and that output is
   validated against `contract/` before the site reads it.
2. **Determinism.** Nothing that lands in the output contains a wall-clock timestamp, a random
   value or the result of unordered iteration. Building twice gives byte-identical output.
3. **One source.** Data comes only from publicdata.au's pinned dated versions, each verified by
   sha256. The build never reads another source and has no fallback to one.
4. **Suppressed values.** A suppressed value renders as "not published" with the reason. It is
   never shown as 0, never left blank and never ranked. The three reasons are:
   - "<5": too few patients.
   - "-": no patients reported.
   - "NP": not published by AIHW.
5. **Reference period and release date.** Every rendered figure carries its reference period and
   the data release date. A figure that cannot state both does not ship.
6. **Terminology.** "Planned surgery" names the category. Copy and URLs use plain "surgery".
   "Elective" appears only where the methodology quotes a source.
7. **Ordering.** Hospitals are ordered by measured numbers only. The site uses no "best hospital"
   language and promotes no practitioner. Private hospitals are excluded, and each page says so. A
   hospital is never ranked on suppressed or stale data.
8. **Privacy.** The compare tool is stateless. The site sets no cookies and uses no localStorage
   or sessionStorage. Search state never appears in the URL or the browser history. Nothing a
   person enters is sent anywhere. The site counts page views with Cloudflare Web Analytics.
   The count sets no cookie and sends nothing a person enters.
9. **Accessibility.** WCAG 2.2 AA is the floor and the checks aim at AAA, as on publicdata.au.
   Pages are HTML-first. Static pages work with zero JavaScript, and the compare tool is
   progressive enhancement. Colour is never the only carrier of meaning. Copy is written for a
   reading age of 12 to 14. [`ACCESSIBILITY.md`](ACCESSIBILITY.md) has the detail.
10. **Separate licences.** The data licences stay separate from the code licence. Data snapshots
    never enter git.
11. **Typed content.** The project's own content, such as copy and labels, lives in typed content
    files and never in components.
