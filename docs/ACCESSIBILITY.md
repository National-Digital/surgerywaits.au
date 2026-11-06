# Accessibility

surgerywaits.au is held to WCAG 2.2 level AA as a floor, and its checks will aim at level AAA, as
[publicdata.au](https://publicdata.au/) does. This page records the commitments and how they are
tested.

## Status

The harness exists and runs in CI as the Accessibility job. It has not yet run over a build of the
site, because the site build has not landed. Today the job proves that every check fires on a page
built to fail it, and that a passing page comes out clean. When the Astro build lands, the job
gains the built pages, and every page type is held to the checks below. The public accessibility
statement on the site will say the same in plain words and will follow this page.

## What the site commits to

- Pages are HTML-first. Static pages work with zero JavaScript.
- The compare tool is progressive enhancement. Without script, a person can still reach every
  hospital's figures from its page.
- Colour is never the only carrier of meaning. A figure that is not published says so in words.
- Copy is written in plain language at a reading age of 12 to 14.
- Every size is relative, so a reader's own browser text size applies.

## How it is tested

The harness is in `scripts/`: `a11y.ts` runs it, and `a11y-audit.ts` and `a11y-checks.ts` hold
the checks. It is TypeScript, run by Node's own type stripping, and it drives Chromium through
Playwright. `npm run a11y` with no argument runs the fixture proof. With a directory of built
HTML, as in `npm run a11y -- <directory>`, it serves that directory and checks every page at
1280 CSS pixels wide and at 390, in light and in dark. The house checks also run at 2560 pixels,
where the type must grow, and at 320 pixels for reflow. axe-core and playwright are pinned to
exact versions in `package.json`, and the playwright version fixes the Chromium build. Install it
with `npx playwright install chromium`.

Each check is proven on a page in `scripts/a11y-fixtures/fail/` built to fail it. A check that
has several outcomes, such as the header menu, has its own rule name and its own fixture for each
outcome, so switching off any one of them fails the proof. The proof also requires the page in
`scripts/a11y-fixtures/pass/` to come out clean in every combination of width and colour scheme.
The same proof runs under `npm test`, where it skips if Chromium is not installed, and in the
Accessibility job, where it always runs. The tests in `scripts/a11y.test.ts` also hold the quiet
cases: a data region, an inline link, a line clamp and a text halo are not flagged.

The link-names check keeps a short list of generic words such as "here", "read more" and
"details". It leaves out the file-format words that publicdata.au lists, such as "csv" and
"json". This site offers no downloads yet, so those words have no use here, and a download link
will be named for what it holds when one is added.

| Check                    | What it tests                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------- |
| axe-core at WCAG 2.2 AAA | Every rule axe has through WCAG 2.2, including enhanced contrast at 7:1.               |
| Painted contrast         | Text that axe cannot measure, such as text on a gradient, is measured from the pixels. |
| Root scale               | The root text size grows with the screen, so type is relative.                         |
| Menu                     | The header menu opens, closes on Escape and shows its links without script.            |
| Focus visible            | A focused control shows an outline of at least 2 pixels.                               |
| Type size                | Text a person reads is at or above a set minimum size.                                 |
| Line length              | No paragraph averages more than 80 characters a line.                                  |
| Target size              | Every link, button and field meets a minimum target size.                              |
| Link names               | No link is named by a word that does not say where it goes.                            |
| Reflow                   | No page scrolls sideways at 320 CSS pixels wide.                                       |
| Text spacing             | With the WCAG text-spacing settings forced, nothing is cut off.                        |

A result a person has judged acceptable is recorded in `scripts/a11y-exceptions.json` with the reason
and the date. An entry that no longer matches anything fails the check, so the list cannot outlive
the markup it describes. The list is empty today.

## What waits for the site

- Running the checks over the built pages. Until then they run over the fixtures only.
- A `data-conformance="aa"` region for dense tables, which the harness already honours, held to
  level AA for target size and type size. Each such region will be named here when it exists.
- Manual testing with a screen reader and keyboard, which no script replaces.

## Report a barrier

If you cannot use part of the site, open a
[bug report](https://github.com/National-Digital/surgerywaits.au/issues/new?template=bug_report.yml)
and give the page URL, what you were trying to do, and the browser and assistive technology you
used. If you prefer to write privately, use the contact page at
[National Digital](https://nationaldigital.com.au/contact/). A barrier is fixed as a bug, and the
fix is described in the pull request that makes it.
