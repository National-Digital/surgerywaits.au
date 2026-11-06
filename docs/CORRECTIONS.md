# Corrections

This policy sets out how a problem with a figure on surgerywaits.au is reported, checked and fixed.

## Report a problem

The site shows what [publicdata.au](https://publicdata.au/) republishes from the Australian
Institute of Health and Welfare (AIHW). Where a report goes depends on where the fault is.

- **A figure that differs from the source.** Open a
  [Data problem](https://github.com/National-Digital/surgerywaits.au/issues/new?template=data-problem.yml)
  issue. Give the page URL, the hospital, the figure shown and the source's own value.
- **An error at the publisher.** The publisher fixes it. The next publicdata.au version carries the
  fix, and the site shows it after its next refresh.
- **An error in this site's processing.** The maintainers fix it and log it below with its date.
- **A security problem.** Report it privately, as [SECURITY.md](../SECURITY.md) describes.

## Check the report

A maintainer compares the figure on the page with the pinned publicdata.au version it came from,
and then with the source's own value.

- If the pinned version and the source agree with each other and differ from the page, the fault is
  in this site's processing.
- If the pinned version differs from the source, the fault is at publicdata.au. The maintainer
  reports it there.
- If the page matches the source, the figure is correct. The issue is closed with a pointer to the
  source. If the source itself is wrong, the publisher fixes it, and the next publicdata.au version
  carries the fix.

## Fix it

A fix to this site's processing is a pull request that corrects the cause and adds a test that
fails without the fix. The pull request description names the pages and figures affected. The
correction is recorded in the log below with its date and the pull request.

## Correction log

Each correction to a published figure is recorded here, newest first. The log is empty.

| Date | Pages affected | What was wrong | What changed | Pull request |
| --- | --- | --- | --- | --- |
