import json
import re
from pathlib import Path
from typing import Any, cast

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted(
    p for pattern in ("*.yml", "*.yaml") for p in (ROOT / ".github" / "workflows").glob(pattern)
)
ACTIONS = sorted(
    p
    for pattern in ("action.yml", "action.yaml")
    for p in (ROOT / ".github" / "actions").glob(f"**/{pattern}")
)
EXPRESSION = re.compile(r"\$\{\{.*?\}\}", re.DOTALL)
GUARD = "github.repository == 'National-Digital/surgerywaits.au'"
PR_TRIGGERS = {
    "pull_request",
    "pull_request_target",
    "merge_group",
    "workflow_run",
    "workflow_call",
}
MEASURED = re.compile(r"lighthouse|lhci|pagespeed|(?<![a-z0-9])psi(?![a-z0-9])", re.IGNORECASE)
PINNED = re.compile(r"@[0-9a-f]{40}$")
VERSION_COMMENT = re.compile(r"#\s*v\d")


def _map(value: object) -> dict[Any, Any]:
    return cast("dict[Any, Any]", value) if isinstance(value, dict) else {}


def _load(text: str) -> dict[Any, Any]:
    return _map(yaml.safe_load(text))


def _triggers(wf: dict[Any, Any]) -> set[str]:
    # YAML 1.1 reads the bare key `on` as True.
    on = wf.get("on", wf.get(True))
    if isinstance(on, str):
        return {on}
    if isinstance(on, list):
        return {str(t) for t in cast("list[object]", on)}
    return set(_map(on))


def _writes(perms: object) -> set[str]:
    if perms == "write-all":
        return {"write-all"}
    return {
        scope
        for scope, level in _map(perms).items()
        if level == "write" and scope != "security-events"
    }


def _reads_secrets(value: object) -> bool:
    text = re.sub(r"secrets\.GITHUB_TOKEN\b", "", json.dumps(value), flags=re.IGNORECASE)
    return any(re.search(r"\bsecrets\b", e, re.IGNORECASE) for e in EXPRESSION.findall(text))


def _guard_ok(condition: object) -> bool:
    expr = re.sub(r"^\$\{\{|\}\}$", "", str(condition or "").strip()).strip()
    if expr == GUARD:
        return True
    return expr.startswith(GUARD + " &&") and "||" not in expr


def _guarded(jobs: dict[Any, Any], name: str, seen: frozenset[str] = frozenset()) -> bool:
    job = _map(jobs[name])
    if _guard_ok(job.get("if")):
        return True
    needs = job.get("needs", [])
    needed = [needs] if isinstance(needs, str) else list(cast("list[str]", needs))
    if not needed or name in seen:
        return False
    return all(n in jobs and _guarded(jobs, n, seen | {name}) for n in needed)


def unguarded_side_effects(text: str) -> list[str]:
    wf = _load(text)
    jobs = _map(wf.get("jobs"))
    shared = _reads_secrets([wf.get("env"), wf.get("defaults")])
    bad: list[str] = []
    for name, raw in jobs.items():
        job = _map(raw)
        perms = job["permissions"] if "permissions" in job else wf.get("permissions")
        effects = (
            bool(_writes(perms))
            or _reads_secrets(job)
            or shared
            or "environment" in job
            or "secrets" in job
        )
        if effects and not _guarded(jobs, name):
            bad.append(name)
    return bad


def measured_on_pull_requests(text: str) -> bool:
    wf = _load(text)
    return bool(_triggers(wf) & PR_TRIGGERS) and bool(MEASURED.search(json.dumps(wf)))


def uses_pull_request_target(text: str) -> bool:
    return "pull_request_target" in _triggers(_load(text))


def _uses_values(node: object) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in cast("dict[Any, Any]", node).items():
            if key == "uses" and isinstance(value, str):
                found.append(value)
            else:
                found.extend(_uses_values(value))
    elif isinstance(node, list):
        for item in cast("list[object]", node):
            found.extend(_uses_values(item))
    return found


def unpinned_uses(text: str) -> list[str]:
    bad: list[str] = []
    lines = text.splitlines()
    for value in _uses_values(yaml.safe_load(text)):
        if value.startswith("./"):
            continue
        after = [ln.split(value, 1)[1] for ln in lines if value in ln and "uses" in ln]
        commented = bool(after) and all(VERSION_COMMENT.search(a) for a in after)
        if not PINNED.search(value) or not commented:
            bad.append(value)
    return bad


def lacks_top_level_permissions(text: str) -> bool:
    perms = _load(text).get("permissions")
    if perms == "read-all":
        return False
    if not isinstance(perms, dict):
        return True
    return any(level == "write" for level in cast("dict[Any, Any]", perms).values())


def floating_runners(text: str) -> list[str]:
    bad: list[str] = []
    for name, raw in _map(_load(text).get("jobs")).items():
        runs_on = _map(raw).get("runs-on")
        if runs_on is None:
            continue
        labels = json.dumps(runs_on)
        if "-latest" in labels or "${{" in labels:
            bad.append(name)
    return bad


SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"

CLEAN = f"""
name: ok
on: pull_request
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@{SHA} # v7.0.1
      - uses: ./.github/actions/local
      - run: echo ${{{{ secrets.GITHUB_TOKEN }}}}
"""

SIDE_EFFECTS = {
    "write scope": "permissions: {contents: write}",
    "workflow write-all": "permissions: write-all",
    "secret": "env: {K: '${{ secrets.DEPLOY_KEY }}'}",
    "environment": "environment: production",
    "toJSON secrets": "env: {K: '${{ toJSON(secrets) }}'}",
    "indexed secret": "env: {K: \"${{ secrets['X'] }}\"}",
    "inherited secrets": "secrets: inherit",
}


def _job(extra: str, guard: str = "") -> str:
    return f"on: push\npermissions: {{}}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    {extra}\n    {guard}\n    steps: []\n"


def test_workflows_exist() -> None:
    assert WORKFLOWS


@pytest.mark.parametrize("extra", SIDE_EFFECTS.values(), ids=SIDE_EFFECTS.keys())
def test_side_effect_fixture_without_guard_is_caught(extra: str) -> None:
    assert unguarded_side_effects(_job(extra)) == ["a"]
    assert unguarded_side_effects(_job(extra, f"if: {GUARD}")) == []


def test_guard_bypasses_are_caught() -> None:
    for cond in (
        f"{GUARD} || true",
        "github.repository != 'National-Digital/surgerywaits.au'",
        f"true || {GUARD}",
        f"{GUARD} && a || b",
    ):
        assert unguarded_side_effects(_job("environment: p", f"if: {cond}")) == ["a"]
    assert unguarded_side_effects(_job("environment: p", f"if: ${{{{ {GUARD} && x }}}}")) == []


def test_needs_chain_must_be_guarded_throughout() -> None:
    base = f"on: push\npermissions: {{}}\njobs:\n  g:\n    runs-on: ubuntu-24.04\n    if: {GUARD}\n    steps: []\n  u:\n    runs-on: ubuntu-24.04\n    steps: []\n"
    side = "  a:\n    runs-on: ubuntu-24.04\n    environment: p\n    needs: {}\n    steps: []\n"
    assert unguarded_side_effects(base + side.format("g")) == []
    assert unguarded_side_effects(base + side.format("[g, u]")) == ["a"]


def test_workflow_level_secrets_and_writes_reach_every_job() -> None:
    jobs = "jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps: []\n"
    assert unguarded_side_effects("on: push\nenv: {K: '${{ secrets.X }}'}\n" + jobs) == ["a"]
    assert unguarded_side_effects(
        "on: push\ndefaults: {run: {shell: '${{ secrets.X }}'}}\n" + jobs
    ) == ["a"]
    assert unguarded_side_effects("on: push\npermissions: write-all\n" + jobs) == ["a"]
    assert unguarded_side_effects("on: push\npermissions: {issues: write}\n" + jobs) == ["a"]
    overridden = jobs.replace("    steps", "    permissions: {contents: read}\n    steps")
    assert unguarded_side_effects("on: push\npermissions: write-all\n" + overridden) == []


def test_security_events_write_and_github_token_are_not_side_effects() -> None:
    assert unguarded_side_effects(_job("permissions: {security-events: write}")) == []
    assert unguarded_side_effects(CLEAN) == []


def test_every_job_with_side_effects_runs_only_in_the_public_repo() -> None:
    found = {f.name: unguarded_side_effects(f.read_text("utf-8")) for f in WORKFLOWS}
    assert {k: v for k, v in found.items() if v} == {}


def test_measurement_fixture_on_a_pull_request_is_caught() -> None:
    for step in (
        "run: npx lhci autorun",
        "run: npx lighthouse x",
        "run: curl pagespeedonline.googleapis.com",
    ):
        text = f"on: pull_request\npermissions: {{}}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - {step}\n"
        assert measured_on_pull_requests(text)
        assert not measured_on_pull_requests(text.replace("pull_request", "schedule"))
    assert not measured_on_pull_requests(CLEAN)


def test_measurement_hidden_outside_steps_or_behind_workflow_run_is_caught() -> None:
    env = "on: merge_group\nenv: {U: 'https://www.googleapis.com/pagespeedonline/v5'}\njobs: {}\n"
    assert measured_on_pull_requests(env)
    assert measured_on_pull_requests("on: workflow_run\njobs:\n  a:\n    steps: [{run: run psi}]\n")
    assert measured_on_pull_requests("on: pull_request\njobs:\n  a:\n    steps: [{run: PSI}]\n")
    assert not measured_on_pull_requests(
        "on: pull_request\njobs:\n  a:\n    steps: [{run: epsilon}]\n"
    )


def test_measurement_in_a_called_workflow_is_caught() -> None:
    text = "on: workflow_call\njobs:\n  a:\n    steps: [{run: npx lhci}]\n"
    assert measured_on_pull_requests(text)


def test_no_pull_request_workflow_measures_performance() -> None:
    bad = [f.name for f in WORKFLOWS if measured_on_pull_requests(f.read_text("utf-8"))]
    assert bad == []


def test_pull_request_target_fixture_is_caught() -> None:
    assert uses_pull_request_target("on:\n  pull_request_target:\njobs: {}\n")
    assert uses_pull_request_target("on: [push, pull_request_target]\njobs: {}\n")
    assert not uses_pull_request_target(CLEAN)


def test_no_workflow_uses_pull_request_target() -> None:
    assert [f.name for f in WORKFLOWS if uses_pull_request_target(f.read_text("utf-8"))] == []


@pytest.mark.parametrize(
    "line",
    [
        "uses: actions/checkout@v4",
        f"uses: actions/checkout@{SHA}",
        f"uses: actions/checkout@{SHA} # latest",
        "uses: actions/checkout@3d3c42e",
    ],
)
def test_unpinned_uses_fixture_is_caught(line: str) -> None:
    assert len(unpinned_uses(f"      - {line}\n")) == 1


def test_flow_style_uses_and_missing_comment_are_caught() -> None:
    assert unpinned_uses("jobs:\n  a:\n    steps: [{uses: actions/checkout@v4}]\n") == [
        "actions/checkout@v4"
    ]
    assert unpinned_uses(f"jobs:\n  a:\n    steps: [{{uses: actions/checkout@{SHA}}}]\n") != []
    assert (
        unpinned_uses(f"jobs:\n  a:\n    steps:\n      - uses: 'actions/checkout@{SHA}' # v7\n")
        == []
    )
    assert unpinned_uses(f"jobs:\n  a:\n    steps: [{{uses: actions/checkout@{SHA}}}] # v7\n") == []


def test_glob_covers_yaml_extension() -> None:
    assert all(f.suffix in {".yml", ".yaml"} for f in WORKFLOWS)


def test_composite_action_fixture_with_unpinned_step_is_caught() -> None:
    text = "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n"
    assert unpinned_uses(text) == ["actions/checkout@v4"]


def test_every_composite_action_is_pinned_to_a_commit_with_a_version_comment() -> None:
    assert {
        f.name: unpinned_uses(f.read_text("utf-8"))
        for f in ACTIONS
        if unpinned_uses(f.read_text("utf-8"))
    } == {}


def test_pinned_and_local_uses_pass() -> None:
    assert unpinned_uses(CLEAN) == []


def test_every_action_is_pinned_to_a_commit_with_a_version_comment() -> None:
    assert {
        f.name: unpinned_uses(f.read_text("utf-8"))
        for f in WORKFLOWS
        if unpinned_uses(f.read_text("utf-8"))
    } == {}


@pytest.mark.parametrize(
    "perms",
    [
        "",
        "permissions:",
        "permissions: write-all",
        "permissions: {contents: write}",
        "permissions: {security-events: write}",
        "permissions: [x]",
    ],
)
def test_bad_top_level_permissions_are_caught(perms: str) -> None:
    assert lacks_top_level_permissions(f"on: push\n{perms}\njobs:\n  a:\n    permissions: {{}}\n")


def test_empty_and_read_all_permissions_pass() -> None:
    assert not lacks_top_level_permissions("on: push\npermissions: {}\njobs: {}\n")
    assert not lacks_top_level_permissions("on: push\npermissions: read-all\njobs: {}\n")


def test_missing_permissions_fixture_is_caught() -> None:
    assert lacks_top_level_permissions("on: push\njobs:\n  a:\n    permissions: {}\n")
    assert not lacks_top_level_permissions(CLEAN)


def test_every_workflow_declares_top_level_permissions() -> None:
    assert [f.name for f in WORKFLOWS if lacks_top_level_permissions(f.read_text("utf-8"))] == []


@pytest.mark.parametrize("image", ["ubuntu-latest", "windows-latest", "${{ matrix.os }}"])
def test_floating_runner_fixture_is_caught(image: str) -> None:
    text = f"jobs:\n  a:\n    runs-on: '{image}'\n"
    assert floating_runners(text) == ["a"]
    assert floating_runners("jobs:\n  a:\n    runs-on: [self-hosted, ubuntu-latest]\n") == ["a"]


def test_named_runner_passes() -> None:
    assert floating_runners(CLEAN) == []


def test_every_job_runs_on_a_named_image() -> None:
    assert {
        f.name: floating_runners(f.read_text("utf-8"))
        for f in WORKFLOWS
        if floating_runners(f.read_text("utf-8"))
    } == {}


REPORTER = "./.github/workflows/report-scheduled-run.yml"


RESULT = re.compile(r"^\$\{\{ needs\.(\w+)\.result \}\}$")
ALL_RESULTS = "${{ contains(needs.*.result, 'failure') && 'failure' || 'success' }}"


def _report_condition_ok(cond: object) -> bool:
    expr = re.sub(r"^\$\{\{|\}\}$", "", str(cond or "").strip()).strip()
    parts = [p.strip() for p in expr.split(" && ")]
    return parts[0] == GUARD and sorted(parts[1:]) == sorted(
        ["always()", "github.event_name == 'schedule'"]
    )


def _report_ok(job: dict[Any, Any], others: set[str]) -> bool:
    needs = job.get("needs", [])
    needed = {needs} if isinstance(needs, str) else set(cast("list[str]", needs))
    with_ = _map(job.get("with"))
    result = str(with_.get("result", ""))
    m = RESULT.match(result)
    result_ok = (m is not None and {m[1]} == needed) or (len(needed) > 1 and result == ALL_RESULTS)
    return (
        _map(job.get("permissions")).get("issues") == "write"
        and _report_condition_ok(job.get("if"))
        and needed == others
        and result_ok
        and bool(with_.get("title"))
        and bool(with_.get("label"))
    )


def unreported_schedule(text: str) -> bool:
    wf = _load(text)
    if "schedule" not in _triggers(wf):
        return False
    jobs = _map(wf.get("jobs"))
    callers = {n for n, j in jobs.items() if _map(j).get("uses") == REPORTER}
    others = set(jobs) - callers
    if any(_map(jobs[n]).get("continue-on-error") for n in others):
        return True
    return not any(_report_ok(_map(jobs[n]), others) for n in callers)


SCHEDULED = f"""
on:
  schedule:
    - cron: '0 0 * * 1'
permissions: {{}}
jobs:
  work:
    runs-on: ubuntu-24.04
    steps: []
  report:
    needs: work
    if: ${{{{ {GUARD} && always() && github.event_name == 'schedule' }}}}
    permissions: {{issues: write}}
    uses: {REPORTER}
    with:
      title: t
      label: l
      result: ${{{{ needs.work.result }}}}
"""


def test_scheduled_workflow_without_a_report_job_is_caught() -> None:
    assert not unreported_schedule(SCHEDULED)
    assert unreported_schedule(SCHEDULED.split("  report:", maxsplit=1)[0])
    assert not unreported_schedule(CLEAN)


@pytest.mark.parametrize(
    "broken",
    [
        ("always() && ", ""),
        (" && github.event_name == 'schedule'", ""),
        (f"{GUARD} && ", ""),
        ("needs: work", "needs: []"),
        ("always()", "!always()"),
        ("&& github.event_name == 'schedule'", "&& github.event_name != 'schedule'"),
        ("always() &&", "always() || x &&"),
        ("${{ needs.work.result }}", "failure"),
        ("      title: t\n", ""),
        ("      label: l\n", ""),
        ("needs: work", "needs: [work, ghost]"),
        ("permissions: {issues: write}", ""),
        ("permissions: {issues: write}", "permissions: {issues: read}"),
        ("  work:\n", "  work:\n    continue-on-error: true\n"),
        (REPORTER, "./.github/workflows/other.yml"),
    ],
)
def test_incomplete_report_job_is_caught(broken: tuple[str, str]) -> None:
    assert unreported_schedule(SCHEDULED.replace(*broken))


def test_reporter_guard_and_scope_pass_the_side_effect_rules() -> None:
    assert unguarded_side_effects(SCHEDULED) == []
    assert unguarded_side_effects(
        SCHEDULED.replace("always() && ", "").replace(GUARD + " && ", "")
    ) == ["report"]


def test_every_scheduled_workflow_reports_through_the_reusable_workflow() -> None:
    assert [f.name for f in WORKFLOWS if unreported_schedule(f.read_text("utf-8"))] == []


def test_report_job_must_need_every_other_job() -> None:
    two = SCHEDULED.replace(
        "  report:", "  more:\n    runs-on: ubuntu-24.04\n    steps: []\n  report:"
    )
    assert unreported_schedule(two)
    both = two.replace("needs: work", "needs: [work, more]").replace(
        "${{ needs.work.result }}", ALL_RESULTS
    )
    assert not unreported_schedule(both)
