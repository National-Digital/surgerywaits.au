# Contributing

surgerywaits.au shows public hospital planned-surgery waiting times in Australia. It is built on
[publicdata.au](https://publicdata.au/) as a worked example of a site that takes all its data from
that service. Contributions are welcome: a bug fix, a correction to how the site processes a
figure, a clearer page, or an accessibility improvement.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
privately as [SECURITY.md](SECURITY.md) describes.

## Ground rules

Checks will enforce the project's rules as the build lands, and until then reviewers apply them.
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#rules-that-decide-the-code) states them. Read that
section before you change anything that shows data, copy or markup.

## Setting up

[`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md) sets out how to install the toolchain and turn on the
git hooks, and where each pinned version lives.

## Making a change

1. Branch from `main`.
2. Make the change, and keep to one concern. An unrelated fix found on the way gets its own pull
   request.
3. Open a pull request. The template asks what changed, why, and how you checked it. Name anything
   a maintainer must do beyond merging.

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

| Check                           | What it does                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Check sign-off                  | Confirms every commit has a `Signed-off-by` line.                                                             |
| Check title                     | Confirms the pull request title is a Conventional Commit.                                                     |
| Secret scan (gitleaks)          | Scans the full history for credentials.                                                                       |
| Workflow lint                   | Lints the workflow files under `.github/workflows/` and every shell file.                                     |
| Review dependency changes       | Fails on a new dependency with a known high or critical vulnerability.                                        |
| Analyze (actions)               | Runs CodeQL static analysis on the workflows.                                                                 |
| Analyze (javascript-typescript) | Runs CodeQL static analysis on the TypeScript and JavaScript.                                                 |
| Analyze (python)                | Runs CodeQL static analysis on the Python.                                                                    |
| Site checks                     | Runs ESLint, Prettier, `astro check` and the TypeScript compiler, knip and vitest.                            |
| Worker build                    | Builds the site, checks the generated Worker types are current and runs `wrangler deploy --dry-run`.          |
| Pipeline checks                 | Runs ruff, pyright and pytest on the pipeline.                                                                |
| Repository tests                | Checks every workflow against the repository's rules, such as pinned actions and least-privilege permissions. |

More checks will join this list as the pipeline and the site are built, and each is added here
when it starts to run.

## Reporting problems

Open an issue with one of the templates: a bug report, a data problem or a feature request. A
figure that differs from the source is a data problem, and [`docs/CORRECTIONS.md`](docs/CORRECTIONS.md)
says how it is handled. Accessibility barriers are reported as
[`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md#report-a-barrier) describes. Security reports go
through [SECURITY.md](SECURITY.md) and never into a public issue.

## Licences

The code and the data carry separate licences. [LICENSE](LICENSE) covers the code and
[LICENSE-DATA.md](LICENSE-DATA.md) covers the data. By contributing code you agree that it is
released under the code licence.
