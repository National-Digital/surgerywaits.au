# Decision records

Each record states decisions that shape surgerywaits.au: what was chosen and why. The rules and
the code that carry them out are described in `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`,
`LICENSE-DATA.md` and the other documents in the repository. Where a record and those documents
disagree on detail, the documents and the code are right and the record is corrected.

## Records

- [0001](0001-architecture-decision-register.md) Architecture decision register: the seventeen
  decisions the rebuild starts from. It is a register, so one record holds several decisions.

## Changing a decision

A change that reverses or narrows a decision adds a record with the next number and the same
headings (Context, Decision, Alternatives considered, Consequences), in the same pull request as
the change. The record it replaces stays, with its status changed to "Superseded by NNNN" and a
link. A record may describe a planned part, and says so. Its status changes when the part lands.

A record's status is **Accepted** or **Superseded by NNNN**.
