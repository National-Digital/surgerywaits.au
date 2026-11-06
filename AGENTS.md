# Agents

Read this file first. It points to where each rule lives and does not restate the architecture rules.

| What must hold                                             | Where to look                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The house rules for data, copy and markup                  | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#rules-that-decide-the-code), one test or planned test per rule |
| Why a rule exists                                          | [`docs/adr/`](docs/adr/README.md)                                                                            |
| Setting up, the checks to run, hooks, CI and pinned tools  | [`CONTRIBUTING.md`](CONTRIBUTING.md#setting-up)                                                              |
| Commit and pull request form                               | [`CONTRIBUTING.md`](CONTRIBUTING.md#commits-and-pull-requests)                                               |
| The library version and documentation page behind a change | The "Docs" line of the [pull request template](.github/PULL_REQUEST_TEMPLATE.md)                             |
| Accessibility and corrections                              | [`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md), [`docs/CORRECTIONS.md`](docs/CORRECTIONS.md)               |
| Security reports                                           | [`SECURITY.md`](SECURITY.md)                                                                                 |
| Licences for code and data                                 | [`LICENSE`](LICENSE), [`LICENSE-DATA.md`](LICENSE-DATA.md)                                                   |
| What a pipeline file or a dist file contains               | The JSON Schema in `contract/`, once it lands. Read the schema and never copy it into a document.            |

## What must hold in every change

- This repository is public and its history is permanent. Commit no secret, credential, internal
  hostname or personal file path.
- Add no attribution to an AI tool, and no agent as an author or co-author, in a commit, a pull
  request, an issue or a file.
- Open an issue only when the person running you names it.
- Check that each function, option and configuration key you call exists in the pinned version, by
  reading the installed package or its source.
- Run the checks in CONTRIBUTING.md before calling a change done, and report which ran and which
  were skipped.
- Add a rule to `docs/ARCHITECTURE.md` only with the test, planned test or check that enforces it.
- Report findings and results to the person running you.
- When reviewing, read the change as code that can look right and still be wrong: a call to a
  function that does not exist, a helper that repeats one already in the repository, or code left
  over from an earlier attempt. Question a new document nobody asked for.
