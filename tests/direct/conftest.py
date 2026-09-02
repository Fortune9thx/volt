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
# Fix: handle ExecPromptTemplate by faithfully echoing the leader's own
# "input" text back as the agreed answer - simulating an LLM that preserves
# a well-formed structured answer unchanged when asked to satisfy the given
# task/criteria against it (the realistic behavior for a well-formed input,
# which is what these tests are constructing). A test can still override
# this per-call by registering a normal vm.mock_llm(pattern, response) whose
# pattern matches the leader's "input" text, exactly as for a plain
# ExecPrompt call.
# ----------------------------------------------------------------------------
from gltest.direct import wasi_mock as _wasi_mock

_original_handle_gl_call = _wasi_mock._handle_gl_call


def _patched_handle_gl_call(vm, request):
    if isinstance(request, dict) and "ExecPromptTemplate" in request:
        return _handle_exec_prompt_template(vm, request["ExecPromptTemplate"])
    return _original_handle_gl_call(vm, request)


def _handle_exec_prompt_template(vm, data):
    # prompt_non_comparative's payload has an "input" key; prompt_comparative's
    # (used by Volt's Stage B) has "leader_answer"/"validator_answer" instead
    # -- fall back to validator_answer so both shapes get *something* to
    # match a registered vm.mock_llm() override against.
    match_text = data.get("input") or data.get("validator_answer") or ""

    override = vm._match_llm_mock(match_text) if match_text else None
    if override is not None:
        if not isinstance(override, str):
            import json as _json
            override = _json.dumps(override)
        return {"ok": override}

    # Default (no override registered): echo back a truthy "agree" result.
    # This means a test that never registers an explicit disagreement mock
    # cannot observe eq_principle's OWN validator voting False from a
    # genuinely different independent answer -- proving that requires the
    # real GenVM node's "EqComparative"/"EqNonComparative*" judgment, which
    # this harness stubs out entirely. This is the same class of gap already
    # documented for gl.eq_principle.strict_eq's spawn_sandbox dependency:
    # a real, disclosed test-harness limitation, not a contract flaw. Stage
    # A's hand-written run_nondet_unsafe validator (_extract_settlement_facts)
    # does NOT go through this path and IS genuinely exercisable -- see
    # test_judgment_consensus.py.
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
