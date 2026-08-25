"""
Access control matrix (see SECURITY.md for the full table):
  create_channel     -- permissionless by design (anyone may create a channel
    under their own Mandate); not tested here as "unauthorized."
  confirm_lock / confirm_channel_closed / mark_relayed -- relayer only
  close_channel      -- channel funder only
  submit_claim       -- any party may submit a claim against an active channel
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


def _create_and_fund_channel(contract, direct_vm, funder, direct_owner, amount_usdc=1000, tx_hash="0xbase_lock"):
    direct_vm.sender = funder
    channel_id = contract.create_channel(
        mandate="Pay 100 USDC if the linked evidence proves the condition.",
        parties=str(funder),
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
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner)
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "approved_amount_usdc": 100, "confidence": "0.95", "reasoning": "Confirmed."},
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
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner)
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "approved_amount_usdc": 100, "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)

        direct_vm.sender = direct_charlie
        with pytest.raises(Exception):
            contract.execute_settlement(claim_id=claim_id)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["status"] == "judged"  # not executed

    def test_claimant_can_execute_their_own_settlement(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(contract, direct_vm, direct_alice, direct_owner)
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=100)
        mock_two_stage_judgment(
            direct_vm,
            facts={"fetch_ok": True, "supports_claim": True},
            intent={"outcome_type": "full", "approved_amount_usdc": 100, "confidence": "0.95", "reasoning": "Confirmed."},
        )
        contract.judge_claim(claim_id=claim_id)
        status = contract.execute_settlement(claim_id=claim_id)
        assert status == "executed"

    def test_non_owner_cannot_set_relayer(self, contract, direct_vm, direct_bob, direct_owner):
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.set_relayer(new_relayer=str(direct_bob))
        assert contract.get_relayer() == str(direct_owner)

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
