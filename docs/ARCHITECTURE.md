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
  `/api/v1/datasets/<slug>/versions`. Suppressed and empty cells arrive as nulls, and a `markers`
  column keeps the publisher's code for each emptied cell. That code gives the reason the site
  shows: "<5" means too few patients, "-" means no patients reported, and "NP" means AIHW did not
  publish. "Not peered" appears only in place of the peer-group columns and the site shows it as
  "not published: no peer group comparison". The Queensland tables carry no markers. A column
  named in their `suppressed` list is "not published: Queensland Health gave no figure", and a
  null in the prior-year change column that the list does not name is "not reported". Any other
  unflagged null fails the build. The credit line uses the citation that publicdata.au publishes
  with each version.
- **`pipeline/` (planned).** A Python 3.13 package built with uv, and checked with ruff, pyright
  in strict mode and pytest. It turns the pinned files into the output files. Its derive step
  builds ranks, trends and a nearby mesh: each located hospital gets its 8 nearest open public
  hospitals by great-circle distance, searched out to 250 km and doubled until 8 are found, across
  state borders and stopping at the Earth's half-circumference. Neighbours are always open
  hospitals, and a closed hospital still gets a mesh so its page can point to open ones. A
  hospital with no coordinates gets no mesh and is listed as such.
- **`contract/` (planned).** JSON Schemas that define every file in the output. The pipeline
  writes to them and the site reads from them.
- **`site/` (planned).** An Astro project with static output. It consumes only the pipeline's
  output.
- **Worker (planned).** A Cloudflare Worker with static assets serves the built site.

## Rules that decide the code

[ADR 0001](adr/0001-architecture-decision-register.md) records why each rule exists. Each rule is
one line and ends with what enforces it. A reference has one of three forms: a pytest function,
`` `path::test_name` ``; a vitest test, `` `path` › "title" ``; or a CI job, ``CI job `Name` ``. A
reference to a test that does not exist yet, a vitest `it.todo` or a skipped pytest, ends with
"(planned)", and the marker is dropped when the test becomes real. `pipeline/tests/test_docs.py`
fails when a reference is malformed, names a test, title or job that does not exist, or has a
planned marker that does not match the test.

- **Two halves, one boundary.** `pipeline/` (Python) builds the data, `site/` (TypeScript) is the front end, and the site reads only the pipeline's dist output, validated against `contract/`. — enforced by `site/src/contracts/gates.test.ts` › "validate against their JSON Schemas in contract/" (planned); `site/src/contracts/gates.test.ts` › "the site reads only the pipeline's dist output" (planned).
- **Determinism.** Nothing in dist holds a wall-clock value, a random value or unordered iteration, and two builds are byte-identical. — enforced by `pipeline/tests/test_contracts.py::test_building_twice_gives_byte_identical_dist` (planned); `pipeline/tests/test_contracts.py::test_no_wall_clock_values_in_dist` (planned); `site/src/contracts/gates.test.ts` › "building the site twice gives byte-identical output" (planned).
- **One source.** Data comes only from publicdata.au's pinned dated versions, each verified by sha256, with no fallback. — enforced by `pipeline/tests/test_contracts.py::test_manifest_entry_pins_slug_version_and_sha256`; `pipeline/tests/test_contracts.py::test_download_with_wrong_digest_fails_closed`.
- **Suppressed values.** A suppressed cell renders "not published" with the publisher's reason, never 0, blank or a rank. The three reasons apply to a hospital's own figures: "<5" means too few patients, "-" means no patients reported and "NP" means AIHW did not publish. — enforced by `pipeline/tests/test_contracts.py::test_every_null_has_a_publisher_marker_or_is_reported`; `pipeline/tests/test_contracts.py::test_every_marker_maps_to_a_known_reason`; `site/src/contracts/gates.test.ts` › "render 'not published' with the reason taken from the publisher's marker (<5, -, NP); an unknown marker fails the build" (planned); `site/src/contracts/gates.test.ts` › "a suppressed cell is never rendered blank or as 0" (planned).
- **Hospital joins.** The waiting-times tables name hospitals instead of coding them, so each hospital row joins to one register code on its name, state and alternative names, and an unmatched or ambiguous row fails the build. — enforced by `pipeline/tests/test_contracts.py::test_unmatched_or_ambiguous_hospital_join_fails`.
- **Not peered.** "Not peered" appears only in place of the peer-group columns, AIHW does not define it, and the site shows it as "not published: no peer group comparison" with no other meaning. — enforced by `site/src/contracts/gates.test.ts` › "'not peered' shows as 'not published: no peer group comparison' and only in place of the peer-group columns" (planned).
- **Reference period and release date.** Every rendered figure carries both, or it does not ship. — enforced by `site/src/contracts/gates.test.ts` › "every rendered figure shows its reference period and the data release date" (planned).
- **Terminology.** "Planned surgery" names the category, copy and URLs say "surgery", and "elective" appears only where the methodology quotes a source. — enforced by `site/src/contracts/gates.test.ts` › "'elective' appears only where the methodology quotes a source" (planned).
- **Ordering.** Hospitals are ordered by measured numbers only, never on suppressed, not-reported,
  closed or stale figures, with no "best hospital" language and no practitioner promotion. A rank
  is a competition rank (1, 2, 2, 4) over one category in the newest period of its table: a lower
  median wait or long-wait share ranks first, a higher on-time share ranks first, and a volume is
  never ranked. A figure is stale when its hospital's latest period for that category is older
  than the newest period in the table.
  — enforced by
  `pipeline/tests/test_contracts.py::test_no_ranking_uses_suppressed_or_stale_rows`;
  `site/src/contracts/gates.test.ts` › "a hospital with suppressed, closed or stale figures (latest period older than the newest in the table) is never ranked" (planned);
  `site/src/contracts/gates.test.ts` › "no 'best hospital' or practitioner-promotion language appears" (planned).
- **Suburb centres.** Each suburb's centre is the area centroid of its ABS shape when that lies inside the shape and otherwise the pole of inaccessibility of its largest part, rounded to 5 decimal places, special-purpose codes are excluded, and a suburb without a shape or a name shared twice within a state fails the build ([ADR 0002](adr/0002-suburb-centre-points.md)). The real-data check runs where the pinned files are cached and will run in CI once a data job pulls them. — enforced by `pipeline/tests/test_suburbs.py::test_centroid_of_a_concave_shape_is_its_area_centroid`; `pipeline/tests/test_suburbs.py::test_fixture_suburbs_whose_centroid_is_outside_get_a_point_inside`; `pipeline/tests/test_suburbs.py::test_special_purpose_codes_are_excluded`; `pipeline/tests/test_suburbs.py::test_a_row_without_a_shape_fails`; `pipeline/tests/test_suburbs.py::test_a_name_shared_within_a_state_fails`.
- **Private hospitals.** Private hospitals are excluded and each page says so. — enforced by `pipeline/tests/test_contracts.py::test_private_sector_is_excluded`; `site/src/contracts/gates.test.ts` › "private hospitals are excluded and the page states the exclusion" (planned).
- **Privacy.** The compare tool is stateless: no cookies, no localStorage or sessionStorage, no search state in the URL or history, and nothing a person enters is sent anywhere. The page-view count with Cloudflare Web Analytics sets no cookie. — enforced by `site/src/contracts/gates.test.ts` › "the site sets no cookies and uses no localStorage or sessionStorage" (planned); `site/src/contracts/gates.test.ts` › "the compare tool puts no search state in the URL or history" (planned); `site/src/contracts/gates.test.ts` › "the page-view count sets no cookie and sends nothing a person enters" (planned); `site/src/contracts/gates.test.ts` › "the privacy check allows exactly the Web Analytics beacon and report hosts" (planned).
- **Accessibility.** WCAG 2.2 AA is the floor and the checks aim at AAA, and colour never carries meaning alone ([`ACCESSIBILITY.md`](ACCESSIBILITY.md)). — enforced by `site/src/contracts/gates.test.ts` › "axe passes at WCAG 2.2 AAA in light mode" (planned); `site/src/contracts/gates.test.ts` › "colour is never the only carrier of meaning" (planned); `scripts/a11y.test.ts` › "each accessibility check is proven to fire on a page built to fail it"; `scripts/a11y.test.ts` › "an accessibility exception that no longer matches anything fails the check"; CI job `Accessibility`.
- **Progressive enhancement.** Pages are HTML-first, static pages ship no JavaScript, and the compare tool enhances a page that already works without script. — enforced by `site/src/contracts/gates.test.ts` › "static pages ship zero JavaScript" (planned); `site/src/contracts/gates.test.ts` › "every hospital's figures are reachable without script" (planned).
- **Valid HTML.** Every page passes the W3C Nu Html Checker with warnings as errors. — enforced by `site/src/contracts/gates.test.ts` › "the W3C Nu Html Checker passes with --Werror" (planned).
- **Separate licences.** The data licences stay apart from the code licence, and no data snapshot enters git. — enforced by `site/src/contracts/gates.test.ts` › "the data licence stays in its own file, apart from the code licence" (planned); `site/src/contracts/gates.test.ts` › "no data snapshot is committed to git" (planned).
- **Typed content.** Copy and labels live in typed content files, never in components. — enforced by `site/src/contracts/gates.test.ts` › "copy lives in typed content files" (planned); `site/src/contracts/gates.test.ts` › "no literal user-visible text appears in components; copy lives in YAML under content/" (planned).
- **Pinned workflows.** Actions are pinned to a commit SHA, each workflow declares permissions, and no pull request workflow runs Lighthouse. — enforced by `pipeline/tests/test_repo.py::test_every_action_is_pinned_to_a_commit_with_a_version_comment`; `pipeline/tests/test_repo.py::test_every_workflow_declares_top_level_permissions`; `pipeline/tests/test_repo.py::test_measurement_runs_only_in_dispatch_only_workflows`.
- **Failing fixtures.** Every gate ships with a fixture built to fail it, and a test proves the gate fires on it. — enforced by `scripts/a11y.test.ts` › "each accessibility check is proven to fire on a page built to fail it"; `pipeline/tests/test_repo.py::test_pull_request_target_fixture_is_caught`; `pipeline/tests/test_testing_rules.py::test_snapshot_directory_fixture_is_caught`.
- **No snapshots.** No HTML snapshot file is committed and no TypeScript test uses a snapshot matcher, so each test asserts specific facts. — enforced by `pipeline/tests/test_testing_rules.py::test_no_snapshot_file_is_tracked`; `pipeline/tests/test_testing_rules.py::test_no_typescript_test_uses_a_snapshot_matcher`.
- **Tests stay offline.** Tests never touch the network, and pytest refuses any connection except to localhost. — enforced by `pipeline/tests/test_testing_rules.py::test_a_connection_to_a_remote_address_is_refused`; `pipeline/tests/test_testing_rules.py::test_a_lookup_of_a_remote_name_is_refused`.
- **No coverage gate.** No coverage percentage fails a build, in Vitest or in pytest. — enforced by `pipeline/tests/test_testing_rules.py::test_no_coverage_percentage_gate_is_configured`.
- **Documents match the repository.** Document links, paths, npm scripts, CI job names and rule references all resolve, and a rule marks a pending test as planned. — enforced by `pipeline/tests/test_docs.py::test_every_rule_in_the_architecture_names_a_test_that_exists`; CI job `Repository tests`.

Copy is written for a reading age of 12 to 14. No test enforces this yet, and reviewers apply it.
