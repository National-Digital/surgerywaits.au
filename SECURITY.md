# Security policy

## Reporting a vulnerability

Report a vulnerability privately through
[GitHub security advisories](https://github.com/National-Digital/surgerywaits.au/security/advisories/new)
or by email to security@nationaldigital.com.au. Please do not open a public issue for anything
exploitable.

We aim to acknowledge a report within a few business days. Please include the steps to reproduce
it and the URL, endpoint or file affected.

## Safe harbour

We welcome good-faith security research. If you report privately through the channels above,
avoid privacy violations and the destruction of data, and go no further than you need to show the
issue, we will treat your research as authorised and will not take or support legal action against
you for it. Please give us reasonable time to fix an issue before you disclose it.

This is an independent public-interest project with no bug bounty. We cannot pay for reports, and
we are glad to credit researchers who want to be named. If you are unsure whether a test is in
scope, ask us first through a private channel.

## Scope

- The site and its deployment.
- The data build in `pipeline/`.
- The GitHub Actions workflows in `.github/`.

Out of scope: Cloudflare's own platform, which should be reported to Cloudflare, and volumetric
denial-of-service findings.

## What we treat as security bugs

- The compare tool is stateless. It sets no cookies and uses no localStorage or sessionStorage.
  Nothing a user enters is sent anywhere. Any code path that stores or transmits user input is a
  security bug.
- Every figure must match the version of the publicdata.au dataset the build pins. The build
  will check each pinned version's sha256. A way to publish a figure that differs from the pinned
  file is a security bug.
- A suppressed value (AIHW code NP) must show as "not published". It must never show as 0, as a
  blank or in a ranking. A way to make it do so is a security bug.

## Controls

- Workflows request the least token scope they need, default to read-only, and pin every action
  to a commit.
- No credential, private hostname or internal address appears anywhere in the repository or in
  its pull requests and issues, comments and commit messages included. Gitleaks scans the whole
  history, and GitHub secret scanning with push protection is on.
- Dependency review runs on every pull request. CodeQL runs on each push to `main`, every week
  and on every pull request.
- Changes to `main` go through a pull request with green checks.
