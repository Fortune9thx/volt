"""
Mandatory pre-submission deliverable: full happy-path critical journey with
assertions at every step, on a single contract instance -- not isolated unit
checks. Mirrors the exact sequence a real funder + claimant + relayer would
perform in the hybrid GenLayer (ledger + judge) / Base Sepolia (vault) model:

  Create channel -> relayer confirms a real Base-side USDC lock -> submit
  claim -> judge claim (full) -> execute settlement (finalizes the GenLayer
  ledger) -> relayer confirms the real Base-side transfer -> channel stays
  open for further claims under the same Mandate -> funder closes the
  channel -> relayer confirms the real Base-side refund.
"""
import json

import pytest

from conftest import mock_two_stage_judgment

CONTRACT_PATH = "contracts/Volt.py"
USDC_UNIT = 10 ** 6


@pytest.fixture
def contract(direct_deploy):
    return direct_deploy(CONTRACT_PATH, sdk_version="v0.2.16")


def test_full_channel_lifecycle_claim_judge_execute_relay_stays_open(contract, direct_vm, direct_owner, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    channel_id = contract.create_channel(
        mandate="Pay the claimant 500 USDC if the referenced shipment tracking page shows status DELIVERED at the destination address.",
        parties=f"{str(direct_alice)},{str(direct_bob)}",
        expiry="2026-12-31",
    )
    assert channel_id == "chn_1"

    channel = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel["status"] == "active"
    assert channel["balance_units"] == "0"  # nothing locked on Base yet

    # Relayer observed a real 1000 USDC lockFunds() call on VoltEscrow (Base Sepolia).
    direct_vm.sender = direct_owner
    contract.confirm_lock(channel_id=channel_id, base_tx_hash="0xbase_lock_1", amount_usdc=1000)
    channel = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel["balance_units"] == str(1000 * USDC_UNIT)

    # The same Base tx hash can never be double-counted.
    with pytest.raises(Exception):
        contract.confirm_lock(channel_id=channel_id, base_tx_hash="0xbase_lock_1", amount_usdc=1000)

    direct_vm.sender = direct_bob
    claim_id = contract.submit_claim(
        channel_id=channel_id,
        evidence="https://example.com/tracking/12345",
        requested_amount_usdc=500,
    )
    assert claim_id == "clm_1"

    mock_two_stage_judgment(
        direct_vm,
        facts={"fetch_ok": True, "supports_claim": True, "facts_summary": "Tracking page shows DELIVERED at destination."},
        intent={"outcome_type": "full", "confidence": "0.96", "reasoning": "Tracking page confirms delivery, satisfying the Mandate."},
    )
    status = contract.judge_claim(claim_id=claim_id)
    assert status == "judged"

    claim = json.loads(contract.get_claim(claim_id=claim_id))
    assert claim["outcome_type"] == "full"
    assert claim["approved_amount_units"] == str(500 * USDC_UNIT)
    assert claim["relayed"] is False

    executed_status = contract.execute_settlement(claim_id=claim_id)
    assert executed_status == "executed"

    channel_after = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel_after["status"] == "active"  # channel stays open
    assert channel_after["balance_units"] == str(500 * USDC_UNIT)
    assert channel_after["total_settled_units"] == str(500 * USDC_UNIT)

    # Relayer confirms it actually executed the real Base-side release.
    direct_vm.sender = direct_owner
    contract.mark_relayed(claim_id=claim_id, base_tx_hash="0xbase_release_1")
    claim_after = json.loads(contract.get_claim(claim_id=claim_id))
    assert claim_after["relayed"] is True
    assert claim_after["base_tx_hash"] == "0xbase_release_1"

    with pytest.raises(Exception):
        contract.mark_relayed(claim_id=claim_id, base_tx_hash="0xbase_release_2")  # already relayed

    # Channel remains usable for a second, independent claim under the same Mandate.
    direct_vm.sender = direct_bob
    second_claim_id = contract.submit_claim(
        channel_id=channel_id,
        evidence="https://example.com/tracking/67890",
        requested_amount_usdc=200,
    )
    assert second_claim_id == "clm_2"
    mock_two_stage_judgment(
        direct_vm,
        facts={"fetch_ok": True, "supports_claim": True, "facts_summary": "Second shipment also shows DELIVERED."},
        intent={"outcome_type": "full", "confidence": "0.93", "reasoning": "Second tracking page also confirms delivery."},
    )
    contract.judge_claim(claim_id=second_claim_id)
    contract.execute_settlement(claim_id=second_claim_id)

    channel_final = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel_final["balance_units"] == str(300 * USDC_UNIT)
    assert channel_final["total_settled_units"] == str(700 * USDC_UNIT)

    # Funder closes the channel; remaining balance is real USDC still on
    # Base until the relayer confirms the refund.
    direct_vm.sender = direct_alice
    contract.close_channel(channel_id=channel_id)
    channel_closing = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel_closing["status"] == "closing"
    assert channel_closing["balance_units"] == str(300 * USDC_UNIT)  # untouched until relayer confirms

    direct_vm.sender = direct_owner
    contract.confirm_channel_closed(channel_id=channel_id, base_tx_hash="0xbase_refund_1")
    channel_closed = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel_closed["status"] == "closed"
    assert channel_closed["balance_units"] == "0"

    # The relayer's system-wide enumeration must see every id, regardless
    # of which party is asking -- not just this funder's/claimant's own.
    assert json.loads(contract.get_all_channel_ids()) == ["chn_1"]
    assert json.loads(contract.get_all_claim_ids()) == ["clm_1", "clm_2"]


def test_claim_with_unfetchable_evidence_fails_closed_and_refunds(contract, direct_vm, direct_owner, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    channel_id = contract.create_channel(
        mandate="Pay 100 USDC if the linked page proves the event occurred.",
        parties=f"{str(direct_alice)},{str(direct_bob)}",
        expiry="2026-12-31",
    )
    direct_vm.sender = direct_owner
    contract.confirm_lock(channel_id=channel_id, base_tx_hash="0xbase_lock_2", amount_usdc=500)

    direct_vm.sender = direct_bob
    claim_id = contract.submit_claim(channel_id=channel_id, evidence="not a url at all", requested_amount_usdc=100)

    direct_vm.clear_mocks()
    status = contract.judge_claim(claim_id=claim_id)
    assert status == "rejected"

    claim = json.loads(contract.get_claim(claim_id=claim_id))
    assert claim["outcome_type"] == "refund"

    channel_after = json.loads(contract.get_channel(channel_id=channel_id))
    assert channel_after["balance_units"] == str(500 * USDC_UNIT)  # untouched
