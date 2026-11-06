# Accessibility

surgerywaits.au is held to WCAG 2.2 level AA as a floor, and its checks will aim at level AAA, as
[publicdata.au](https://publicdata.au/) does. This page records the commitments and how they are
tested.

## Status

The checks described below are being built. None exists yet, and this page states what each will
do once it does. The public accessibility statement on the site will say the same in plain words
and will follow this page.

## What the site commits to

- Pages are HTML-first. Static pages work with zero JavaScript.
- The compare tool is progressive enhancement. Without script, a person can still reach every
  hospital's figures from its page.
- Colour is never the only carrier of meaning. A figure that is not published says so in words.
- Copy is written in plain language at a reading age of 12 to 14.
- Every size is relative, so a reader's own browser text size applies.

## How it is tested

The checks will run over a build of every kind of page, in light and in dark. Each check will be
proven to fire on a page built to fail it before it is trusted to pass a real page.

| Check                    | What it tests                                                            |
| ------------------------ | ------------------------------------------------------------------------ |
| axe-core at WCAG 2.2 AAA | Every rule axe has through WCAG 2.2, including enhanced contrast at 7:1. |
| Type size                | Text a person reads is at or above a set minimum size.                   |
| Line length              | No paragraph averages more than 80 characters a line.                    |
| Target size              | Every link, button and field meets a minimum target size.                |
| Link names               | No link is named by a word that does not say where it goes.              |
| Reflow                   | No page scrolls sideways at 320 CSS pixels wide.                         |
| Text spacing             | With the WCAG text-spacing settings forced, nothing is cut off.          |

A result a person has judged acceptable is recorded with the reason and the date. An entry that no
longer matches anything fails the check, so the list cannot outlive the markup it describes.

## Report a barrier

If you cannot use part of the site, open a
[bug report](https://github.com/National-Digital/surgerywaits.au/issues/new?template=bug_report.yml)
and give the page URL, what you were trying to do, and the browser and assistive technology you
used. If you prefer to write privately, use the contact page at
[National Digital](https://nationaldigital.com.au/contact/). A barrier is fixed as a bug, and the
fix is described in the pull request that makes it.
