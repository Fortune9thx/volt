"""
Optional hardening requested alongside a GenLayer steward review: evidence
sourcing was previously entirely up to whatever the claimant unilaterally
picked at claim time. create_channel now accepts an optional
allowed_evidence_domains allowlist, agreed by the funder BEFORE any
specific claim or dispute exists -- submit_claim rejects the whole claim
if any submitted URL isn't from an allowed domain. Left empty, sourcing
stays unrestricted (backward compatible, preserves arbitrary-Mandate
flexibility for Mandates that don't need this).
"""
import json

import pytest

CONTRACT_PATH = "contracts/Volt.py"
USDC_UNIT = 10 ** 6


@pytest.fixture
def contract(direct_deploy):
    return direct_deploy(CONTRACT_PATH, sdk_version="v0.2.16")


def _create_and_fund_channel(contract, direct_vm, funder, direct_owner, allowed_evidence_domains, amount_usdc=1000, tx_hash="0xbase_lock", parties=None):
    direct_vm.sender = funder
    channel_id = contract.create_channel(
        mandate="Pay 100 USDC if the linked evidence proves the condition.",
        parties=parties if parties is not None else str(funder),
        expiry="2026-12-31",
        allowed_evidence_domains=allowed_evidence_domains,
    )
    direct_vm.sender = direct_owner
    contract.confirm_lock(channel_id=channel_id, base_tx_hash=tx_hash, amount_usdc=amount_usdc)
    return channel_id


class TestEvidenceSourceRestriction:
    def test_unrestricted_channel_accepts_any_http_evidence(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(
            contract, direct_vm, direct_alice, direct_owner, allowed_evidence_domains="", parties=f"{str(direct_alice)},{str(direct_bob)}"
        )
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://anything-at-all.example/e", requested_amount_usdc=50)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["status"] == "pending"

    def test_restricted_channel_rejects_evidence_from_a_non_allowed_domain(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(
            contract, direct_vm, direct_alice, direct_owner, allowed_evidence_domains="github.com", parties=f"{str(direct_alice)},{str(direct_bob)}"
        )
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.submit_claim(channel_id=channel_id, evidence="https://not-github.example/e", requested_amount_usdc=50)
        assert json.loads(contract.get_all_claim_ids()) == []

    def test_restricted_channel_accepts_evidence_from_an_allowed_domain(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        channel_id = _create_and_fund_channel(
            contract, direct_vm, direct_alice, direct_owner, allowed_evidence_domains="github.com", parties=f"{str(direct_alice)},{str(direct_bob)}"
        )
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://github.com/torvalds/linux", requested_amount_usdc=50)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["status"] == "pending"

    def test_one_disallowed_url_among_several_rejects_the_whole_claim(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # A claimant must not be able to pad a claim with one approved URL
        # and one self-serving one and hope the approved one carries it.
        channel_id = _create_and_fund_channel(
            contract, direct_vm, direct_alice, direct_owner, allowed_evidence_domains="github.com", parties=f"{str(direct_alice)},{str(direct_bob)}"
        )
        direct_vm.sender = direct_bob
        with pytest.raises(Exception):
            contract.submit_claim(
                channel_id=channel_id,
                evidence="https://github.com/torvalds/linux\nhttps://attacker-controlled.example/fake",
                requested_amount_usdc=50,
            )
        assert json.loads(contract.get_all_claim_ids()) == []

    def test_multiple_allowed_domains_and_full_url_vs_bare_domain_normalize_the_same(self, contract, direct_vm, direct_owner, direct_alice, direct_bob):
        # Funder may list either bare domains or full URLs when creating
        # the channel -- both must normalize identically.
        channel_id = _create_and_fund_channel(
            contract, direct_vm, direct_alice, direct_owner,
            allowed_evidence_domains="https://github.com, www.example.com",
            parties=f"{str(direct_alice)},{str(direct_bob)}",
        )
        direct_vm.sender = direct_bob
        claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://www.github.com/torvalds/linux", requested_amount_usdc=50)
        claim = json.loads(contract.get_claim(claim_id=claim_id))
        assert claim["status"] == "pending"

        second_claim_id = contract.submit_claim(channel_id=channel_id, evidence="https://example.com/e", requested_amount_usdc=25)
        second_claim = json.loads(contract.get_claim(claim_id=second_claim_id))
        assert second_claim["status"] == "pending"
