"""
Tests specifically targeting the two consensus-binding gaps found in a
pre-submission audit against real GenLayer Portal rejection patterns:

1. The exact fund-moving amount must never depend on a free-typed model
   field -- "full"/"refund" are fully deterministic (100%/0% of the
   requested amount) and "partial" is computed in contract code from a
   fixed set of buckets (25/50/75%) the model can only choose among. These
   tests prove that arithmetic, independent of any eq_principle behavior.

2. Stage A's fail-closed evidence gate (_extract_settlement_facts) uses a
   hand-written gl.vm.run_nondet_unsafe validator that independently
   re-fetches and re-extracts rather than just checking the leader's JSON
   is well-formed. This IS exercisable in gltest direct-mode via
   direct_vm.run_validator() (unlike gl.eq_principle-mediated validators --
   see conftest.py's _handle_exec_prompt_template comment for why Stage B's
   own prompt_comparative validator is NOT independently provable in this
   harness, a disclosed limitation, not a contract gap).
"""
import json

import pytest

from conftest import mock_two_stage_judgment

CONTRACT_PATH = "contracts/Volt.py"
USDC_UNIT = 10 ** 6


@pytest.fixture
def contract(direct_deploy):
    return direct_deploy(CONTRACT_PATH, sdk_version="v0.2.16")


def _create_and_fund_channel(contract, direct_vm, funder, direct_owner, amount_usdc=1000, tx_hash="0xbase_lock", parties=None):
    direct_vm.sender = funder
    channel_id = contract.create_channel(
        mandate="Pay the requested amount if the linked evidence proves the condition.",
        parties=parties if parties is not None else str(funder),
        expiry="2026-12-31",
    )
    direct_vm.sender = direct_owner
    contract.confirm_lock(channel_id=channel_id, base_tx_hash=tx_hash, amount_usdc=amount_usdc)
    return channel_id


class TestDeterministicPayoutBuckets:
    @pytest.mark.parametrize("percent,expected_fraction", [(25, 4), (50, 2)])
    def test_partial_bucket_computed_deterministically(self, contract, direct_vm, direct_owner, direct_alice, direct_bob, percent, expected_fraction):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, amount_usdc=1000, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=400)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "partial", "partial_percent": percent, "confidence": "0.9", "reasoning": "Partially met."},
        )
        contract.judge_claim(claim_id=claim_id)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["outcome_type"] == "partial"
        assert claim["approved_amount_units"] == str((400 // expected_fraction) * USDC_UNIT)

    def test_partial_75_percent_bucket(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, amount_usdc=1000, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=400)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "partial", "partial_percent": 75, "confidence": "0.9", "reasoning": "Mostly met."},
        )
        contract.judge_claim(claim_id=claim_id)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["approved_amount_units"] == str(300 * USDC_UNIT)

    def test_partial_with_out_of_bucket_percent_refuses_safely(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # A "partial" verdict with a percent outside {25, 50, 75} is not a
        # value the contract can bind to consensus -- refuse rather than
        # trust an arbitrary number.
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=400)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "partial", "partial_percent": 40, "confidence": "0.9", "reasoning": "Off-bucket."},
        )
        status = contract.judge_claim(claim_id=claim_id)
        assert status == "judged"
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["outcome_type"] == "refund"
        assert claim["approved_amount_units"] == "0"

    def test_full_outcome_ignores_any_model_suggested_amount(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # There is no LLM-controlled amount field for "full" at all -- even
        # a stray/malicious partial_percent alongside outcome_type "full"
        # must not influence the payout, which is always exactly the
        # requested amount.
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=400)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "partial_percent": 999, "confidence": "0.95", "reasoning": "Fully met."},
        )
        contract.judge_claim(claim_id=claim_id)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["approved_amount_units"] == str(400 * USDC_UNIT)


class TestStageAIndependentValidation:
    def test_validator_disagrees_when_independent_fetch_contradicts_leader(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)

        direct_vm.clear_mocks()
        direct_vm.mock_web(r"example\.com", {
            "method": "GET", "status": 200,
            "body": "Real evidence content confirming the claimed condition occurred, with specific checkable details.",
        })
        direct_vm.mock_llm(r"extracting objective facts only", json.dumps({"facts_summary": "Confirms the condition.", "supports_claim": True}))
        direct_vm.mock_llm(r"adjudicating a Settlement Claim", json.dumps({"outcome_type": "full", "confidence": "0.95", "reasoning": "Confirmed."}))
        contract.judge_claim(claim_id=claim_id)  # leader path: claim judged "full"

        # Simulate an independent validator fetching the SAME url but seeing
        # content that does NOT support the claim (e.g. the leader
        # misreported what it fetched, or the page differs per-request).
        # Stage A's hand-written validator must independently re-derive
        # fetch_ok/supports_claim and vote False on disagreement -- not just
        # check that the leader's JSON is well-formed.
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"example\.com", {"method": "GET", "status": 200, "body": "This page shows nothing relevant to any claim."})
        direct_vm.mock_llm(r"extracting objective facts only", json.dumps({"facts_summary": "No relevant content.", "supports_claim": False}))

        agrees = direct_vm.run_validator(index=0)  # index 0 = Stage A's run_nondet_unsafe
        assert agrees is False

    def test_validator_agrees_when_independent_fetch_matches_leader(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)

        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)

        # No mock swap this time -- the validator re-fetches under the SAME
        # still-registered mocks and must agree with the leader.
        agrees = direct_vm.run_validator(index=0)
        assert agrees is True
