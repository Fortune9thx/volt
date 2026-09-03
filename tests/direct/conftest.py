"""
Windows compatibility shim for gltest's direct-mode message injection.

gltest.direct.loader._inject_message_to_fd0 (genlayer-test==0.29.2) does:
    os.dup2(fd, 0)   # duplicate the temp file's fd onto stdin
    os.close(fd)     # close the original fd
    os.unlink(path)  # delete the temp file

On POSIX this works because unlinking an open file just removes the
directory entry while the still-open fd (now living at fd 0) keeps the
data alive. On Windows, os.unlink refuses to remove a file that any
handle still has open - fd 0 still points at it via dup2 - so this raises
PermissionError (WinError 32) on every direct-mode contract deploy.

This is an upstream bug in the library, not in the contract under test.
We patch os.unlink to swallow exactly that failure so test collection
can proceed; the OS will actually delete the temp file once fd 0 is
closed/reused at process exit.
"""
import os

_original_unlink = os.unlink


def _tolerant_unlink(path, *args, **kwargs):
    try:
        _original_unlink(path, *args, **kwargs)
    except PermissionError:
        pass


os.unlink = _tolerant_unlink


# ----------------------------------------------------------------------------
# gltest.direct.wasi_mock._handle_gl_call (genlayer-test==0.29.2) dispatches
# "ExecPrompt" requests (plain gl.nondet.exec_prompt calls) to mock_llm, but
# has NO case at all for "ExecPromptTemplate" - the request type the real SDK
# uses internally for gl.eq_principle.prompt_non_comparative/prompt_comparative
# (see genlayer/gl/eq_principle.py: leader_fn wraps our input through a
# second ExecPromptTemplate call with template="EqNonComparativeLeader").
# Unmocked, that falls through to "Unknown gl_call request type", the fd
# comes back invalid, and prompt_non_comparative silently resolves to None -
# meaning the Equivalence Principle itself, GenLayer's core consensus
# mechanism, cannot currently be exercised via gltest direct mode at all
# without this patch. This is a gap in the test harness, not in the SDK or
# in this contract.
#
# Reading genlayer/gl/eq_principle.py directly (not just its docstrings)
# shows prompt_comparative's validator_fn is implemented as a PLAIN
# vm.run_nondet.lazy(fn, validator_fn) call -- no vm.spawn_sandbox involved
# (unlike strict_eq, whose separate cloudpickle-sandbox dependency IS a real,
# still-open gap -- see the strict_eq memory). That means Stage B's own
# validator_fn is captured by direct-mode's _captured_validators list exactly
# like Stage A's, and IS genuinely invocable via direct_vm.run_validator()
# -- it was only ever the ExecPromptTemplate handling below that stood in
# the way, not an architectural limit of the harness. Two fixes were needed:
#
# 1. A registered vm.mock_llm(pattern, response) override for an
#    EqComparative/EqNonComparativeValidator decision must pass a real bool
#    through UNCHANGED. The previous version of this patch always
#    json.dumps()'d a non-str override before wrapping it in {"ok": ...} --
#    turning an intended `False` (disagreement) into the JSON *string*
#    "false", which calldata round-trips as a non-empty string and is
#    therefore truthy back in eq_principle.py's `return ret.get()`. That
#    silently flipped every disagreement override into an agreement.
# 2. The *default* (no override registered) previously always returned a
#    truthy "agree" regardless of what leader/validator actually produced --
#    meaning no test could observe a genuine mismatch without ALSO manually
#    computing and asserting the "right" answer itself, which would just be
#    testing the test. The default below instead re-derives agreement from
#    exactly the fields Volt's own `judge_claim` principle text names as
#    consensus-critical (outcome_type, confidence_tier, and partial_percent
#    when outcome_type is "partial") -- the same kind of hand-written,
#    deterministic equivalence check already proven for Stage A's
#    _summaries_agree, applied here to simulate what a real GenVM validator
#    LLM would conclude when asked to judge two answers against that exact
#    principle.
# ----------------------------------------------------------------------------
import json as _json
from gltest.direct import wasi_mock as _wasi_mock

_original_handle_gl_call = _wasi_mock._handle_gl_call

_VALIDATOR_VOTE_TEMPLATES = ("EqComparative", "EqNonComparativeValidator")


def _patched_handle_gl_call(vm, request):
    if isinstance(request, dict) and "ExecPromptTemplate" in request:
        return _handle_exec_prompt_template(vm, request["ExecPromptTemplate"])
    return _original_handle_gl_call(vm, request)


def _stage_b_intent_fields_agree(leader_answer: str, validator_answer: str) -> bool:
    """Mirrors judge_claim's own prompt_comparative `principle` text: two
    Stage B answers are equivalent only if outcome_type and confidence_tier
    match exactly, and -- when outcome_type is "partial" -- partial_percent
    also matches exactly. Differences in reasoning wording or the numeric
    confidence value never count. Falls back to plain string equality for
    non-JSON/non-dict input rather than guessing."""
    try:
        leader = _json.loads(leader_answer)
        validator = _json.loads(validator_answer)
    except (ValueError, TypeError):
        return leader_answer == validator_answer
    if not isinstance(leader, dict) or not isinstance(validator, dict):
        return leader_answer == validator_answer
    if leader.get("outcome_type") != validator.get("outcome_type"):
        return False
    if leader.get("confidence_tier") != validator.get("confidence_tier"):
        return False
    if leader.get("outcome_type") == "partial" and leader.get("partial_percent") != validator.get("partial_percent"):
        return False
    return True


def _handle_exec_prompt_template(vm, data):
    template = data.get("template")

    if template in _VALIDATOR_VOTE_TEMPLATES:
        # Both templates decide a validator's boolean equivalence vote
        # (EqComparative for prompt_comparative, EqNonComparativeValidator
        # for prompt_non_comparative). Match on validator_answer first --
        # prompt_comparative has no "input" key at all.
        match_text = data.get("validator_answer") or data.get("input") or ""
        override = vm._match_llm_mock(match_text) if match_text else None
        if override is not None:
            if isinstance(override, str):
                vote = override.strip().lower() not in ("false", "0", "")
            else:
                vote = bool(override)
            return {"ok": vote}
        leader_answer = data.get("leader_answer", data.get("output", ""))
        validator_answer = data.get("validator_answer", data.get("input", ""))
        return {"ok": _stage_b_intent_fields_agree(str(leader_answer), str(validator_answer))}

    # EqNonComparativeLeader (and any other template): echo the leader's own
    # "input" text back as the agreed answer -- simulating an LLM that
    # preserves a well-formed structured answer unchanged when asked to
    # satisfy the given task/criteria against it. A test can still override
    # this per-call via a normal vm.mock_llm(pattern, response) matching the
    # leader's "input" text, exactly as for a plain ExecPrompt call.
    match_text = data.get("input") or data.get("validator_answer") or ""
    override = vm._match_llm_mock(match_text) if match_text else None
    if override is not None:
        if not isinstance(override, str):
            override = _json.dumps(override)
        return {"ok": override}
    return {"ok": match_text}


_wasi_mock._handle_gl_call = _patched_handle_gl_call


# ----------------------------------------------------------------------------
# Shared helper for tests: Volt.judge_claim runs TWO gl.nondet.exec_prompt
# calls (Stage A fact extraction, Stage B intent judgment), distinguished by
# fixed marker phrases in each prompt ("extracting objective facts only" vs
# "adjudicating a Settlement Claim"). Registering both mocks by matching on
# those markers keeps every test's judgment outcome fully controllable
# without needing to know the exact wording of the rest of either prompt.
# ----------------------------------------------------------------------------
import json as _json


def mock_default_evidence_fetch(direct_vm, url_pattern=r"example\.com", body="Real evidence content confirming the claimed condition occurred, with specific checkable details."):
    """Registers a web mock for the evidence URL(s) Stage A will fetch.
    Every claim test whose contract call reaches Stage A needs this mocked,
    or gltest raises MockNotFoundError."""
    direct_vm.mock_web(url_pattern, {
        "method": "GET", "status": 200, "body": body,
    })


def mock_two_stage_judgment(direct_vm, facts: dict, intent: dict, evidence_url_pattern=r"example\.com"):
    """facts: the Stage A extraction result, e.g. {"fetch_ok": True,
    "supports_claim": True, "facts_summary": "..."}.

    intent: the Stage B result, e.g. {"outcome_type": "full",
    "confidence_tier": "high", "confidence": "0.95", "reasoning": "..."},
    or for a partial outcome, {"outcome_type": "partial",
    "partial_percent": 50, "confidence_tier": "high", "confidence": "0.9",
    "reasoning": "..."} -- partial_percent must be one of the fixed buckets
    the contract accepts (25/50/75); confidence_tier must be exactly "high"
    to avoid the confidence gate forcing a refund (the numeric confidence
    value is display-only, never used for gating -- see judge_claim); the
    exact USDC amount is never taken from the model directly."""
    facts = dict(facts)
    facts.setdefault("fetch_ok", True)
    facts.setdefault("supports_claim", True)
    facts.setdefault("facts_summary", "Verified content supports the claimed condition.")
    facts.setdefault("record_summary", facts["facts_summary"])
    direct_vm.clear_mocks()
    mock_default_evidence_fetch(direct_vm, evidence_url_pattern)
    direct_vm.mock_llm(r"extracting objective facts only", _json.dumps(facts))
    direct_vm.mock_llm(r"adjudicating a Settlement Claim", _json.dumps(intent))
