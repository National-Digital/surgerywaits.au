# Agents

Before opening or updating a change, read [`README.md`](README.md) and every document it links to,
including [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md). They hold the
project's rules, which apply to agents as to everyone. This file adds only what is particular to
agents.

- The house rules are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#rules-that-decide-the-code).
  Follow them in every change.
- Never commit secrets, credentials, internal hostnames or personal file paths. This repository is
  public and its history is permanent.
- An agent cannot certify the
  [Developer Certificate of Origin](CONTRIBUTING.md#commits-and-pull-requests). The person running
  the agent reviews the change and signs off each commit.
- Never add an agent as an author or co-author of a commit.
- Add no attribution to an AI tool in a commit message, a pull request, an issue or a file.
- Report findings and results to the person running the agent.
- Never open an issue on your own. Open one only when the person running you names it.
- Check that every function, option and configuration key you call exists in the version the
  project pins, by reading the installed package or its source.
- Before calling a change done, run the checks the project documents and say which ran and which
  were skipped.
- When reviewing, read the change as code that can look right and still be wrong: a call to a
  function that does not exist, a helper that repeats one already in the repository, or code left
  over from an earlier attempt. Question a new document nobody asked for.
