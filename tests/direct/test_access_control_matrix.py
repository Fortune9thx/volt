"""
Access control matrix (see SECURITY.md for the full table):
  create_channel     -- permissionless by design (anyone may create a channel
    under their own Mandate); not tested here as "unauthorized."
  confirm_lock / confirm_channel_closed / mark_relayed -- relayer only
  close_channel      -- channel funder only
  submit_claim       -- funder or a listed party ONLY (NOT_CHANNEL_PARTY for
    anyone else -- a random wallet must not be able to submit a claim against
    someone else's channel and become the relayer-paid recipient)
  judge_claim        -- permissionless trigger (the verdict itself carries no
    discretion for the caller -- see SECURITY.md)
  execute_settlement -- channel funder, claimant, or contract owner only
  set_relayer / pause_contract / unpause_contract -- contract owner only

Each test asserts both the revert AND that contract state is unchanged.
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
        mandate="Pay 100 USDC if the linked evidence proves the condition.",
        parties=parties if parties is not None else str(funder),
        expiry="2026-12-31",
    )
    direct_vm.sender = direct_owner
    contract.confirm_lock(channel_id=channel_id, base_tx_hash=tx_hash, amount_usdc=amount_usdc)
    return channel_id


class TestAccessControlMatrix:
    def test_non_relayer_cannot_confirm_lock(self, contract, direct_vm, direct_alice, direct_bob):
        direct_vm.sender = direct_alice
        channel_id = contract.create_channel(mandate="x" * 20, parties=str(direct_alice), expiry="2026-12-31")
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.confirm_lock(channel_id=channel_id, base_tx_hash="0xfake", amount_usdc=1000)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["balance_units"] == "0"

    def test_non_relayer_cannot_mark_relayed(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "confidence_tier": "high", "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)
        contract.execute_settlement(claim_id=claim_id)

        direct_vm.sender = direct_bob  # claimant, not relayer
        with pytest.raises(Exception):
            contract.mark_relayed(claim_id=claim_id, base_tx_hash="0xnotrelayer")
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["relayed"] is False

    def test_non_funder_cannot_close_channel(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner)
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.close_channel(channel_id=channel_id)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["status"] == "active"

    def test_non_relayer_cannot_confirm_channel_closed(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner)
        direct_vm.sender = direct_alice
        contract.close_channel(channel_id=channel_id)
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.confirm_channel_closed(channel_id=channel_id, base_tx_hash="0xnotrelayer")
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["status"] == "closing"

    def test_non_owner_non_funder_non_claimant_cannot_execute_settlement(self, contract, direct_vm, direct_owner, direct_alice, direct_bob, direct_charlie):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "confidence_tier": "high", "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)

        direct_vm.sender = direct_charlie
        with pytest.raises(Exception):
            contract.execute_settlement(claim_id=claim_id)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["status"] == "judged"  # not executed

    def test_claimant_can_execute_their_own_settlement(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "confidence_tier": "high", "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)
        status = contract.execute_settlement(claim_id=claim_id)
        assert status == "executed"

    def test_non_party_cannot_submit_claim(self, contract, direct_vm, direct_owner, direct_alice, direct_bob, direct_charlie):
        # The critical fix: submit_claim used to accept ANY caller as the
        # claimant, and the relayer pays claim.claimant directly on Base
        # (scripts/relayer.mjs settle() recipient) -- an unrestricted wallet
        # could otherwise divert a real settlement to itself.
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_charlie  # not the funder, not in parties
        with pytest.raises(Exception):
            contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["balance_units"] == str(1000 * USDC_UNIT)  # untouched
        assert json.loads(contract.get_all_claim_ids()) == []

    def test_listed_party_can_submit_claim(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["status"] == "pending"

    def test_list_channels_by_party_matches_regardless_of_wallet_address_case(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # Regression test for a real GenLayer rejection pattern: a TreeMap
        # (or, here, a linear-scan comparison) keyed by a checksummed
        # canonical address silently fails to match a raw, differently-cased
        # wallet-returned address -- a genuine party would otherwise see an
        # empty dashboard with no error at all.
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        alice_hex = str(direct_alice)
        lowered = alice_hex.lower()
        uppered = "0x" + alice_hex[2:].upper()

        via_lower = json.loads(contract.list_channels_by_party(address=lowered))
        via_upper = json.loads(contract.list_channels_by_party(address=uppered))
        assert [c["id"] for c in via_lower] == [channel_id]
        assert [c["id"] for c in via_upper] == [channel_id]

    def test_close_channel_allowed_despite_pending_claim(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # A "pending" claim must NOT block closure. judge_claim's own
        # resolution depends on non-deterministic consensus, which is not
        # guaranteed to ever converge -- blocking closure on it would let a
        # single claim with unstable evidence strand the channel's entire
        # remaining balance forever, with no escape hatch. Only a "judged"
        # claim (deterministically resolvable by the funder themselves via
        # execute_settlement) blocks closure -- see the next test.
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        direct_vm.sender = direct_alice
        contract.close_channel(channel_id=channel_id)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["status"] == "closing"

    def test_close_channel_blocked_by_judged_but_unexecuted_claim(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # Real griefing vector this closes: without this guard, a funder
        # could close_channel the instant a claim is judged in the
        # claimant's favor but before execute_settlement runs, permanently
        # blocking payout since judge_claim/execute_settlement both require
        # an "active" channel and closure never reverts to "active".
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "confidence_tier": "high", "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)
        direct_vm.sender = direct_alice
        with pytest.raises(Exception):
            contract.close_channel(channel_id=channel_id)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["status"] == "active"

    def test_close_channel_succeeds_once_claim_is_executed(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "confidence_tier": "high", "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)
        contract.execute_settlement(claim_id=claim_id)
        direct_vm.sender = direct_alice
        contract.close_channel(channel_id=channel_id)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["status"] == "closing"

    def test_close_channel_succeeds_once_claim_is_rejected(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner, parties=f"{str(direct_alice)},{str(direct_bob)}")
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="not a url at all", requested_amount_usdc=100)
        direct_vm.clear_mocks()
        contract.judge_claim(claim_id=claim_id)  # fails closed -> "rejected", not blocking
        direct_vm.sender = direct_alice
        contract.close_channel(channel_id=channel_id)
        channel = json.loads(contract.get_channel(channel_id=channel_id))
        assert channel["status"] == "closing"

    def test_non_owner_cannot_set_relayer(self, contract, direct_vm, direct_bob, direct_owner):
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.set_relayer(new_relayer=str(direct_bob))
        assert contract.get_relayer() == str(direct_owner).lower()  # stored/returned addresses are lowercase-normalized

    def test_non_owner_cannot_pause_contract(self, contract, direct_vm, direct_bob):
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.pause_contract()
        assert contract.is_paused() is False

    def test_non_owner_cannot_unpause_contract(self, contract, direct_vm, direct_bob, direct_owner):
        direct_vm.sender = direct_owner
        contract.pause_contract()
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.unpause_contract()
        assert contract.is_paused() is True

    def test_paused_contract_rejects_new_channels_and_claims(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner)
        direct_vm.sender = direct_owner
        contract.pause_contract()

        direct_vm.sender = direct_alice
        with pytest.raises(Exception):
            contract.create_channel(mandate="x" * 20, parties=str(direct_alice), expiry="2026-12-31")

        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=10)
