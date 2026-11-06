# surgerywaits.au

surgerywaits.au shows how long people wait for planned surgery at public hospitals in Australia. It
is built on [publicdata.au](https://publicdata.au/) and takes all its data from that service.

## What the site shows

Each public hospital page lists waiting times by specialty, with the reference period and the data
release date beside every figure. Where the publisher withholds a figure, the page says "not
published" and gives the reason. Hospitals are ordered by measured numbers only. Private hospitals
are not included, and each page says so.

## Set up

You need Node 26, Python 3.13 and `uv`. No credentials are needed.

```
git config core.hooksPath .githooks
npm ci
cd pipeline && uv sync
```

[CONTRIBUTING.md](CONTRIBUTING.md#setting-up) explains the git hooks and how to run each check.

## Contribute

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to make a change, how commits are signed off and
which checks run on a pull request. Report a figure that differs from its source as a data problem
using the issue templates. Report a security issue as [SECURITY.md](SECURITY.md) describes. By
taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Decisions and design

- [Architecture decision records](docs/adr/README.md) set out why the project is built as it is.
- [Architecture](docs/ARCHITECTURE.md) states the rules that decide the code, each with the test
  or planned test that enforces it.

## Licences

The code is released under [LICENSE](LICENSE). The data carries its own licence, set out in
[LICENSE-DATA.md](LICENSE-DATA.md), and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists
third-party material. [GOVERNANCE.md](GOVERNANCE.md) describes how the project is run.
