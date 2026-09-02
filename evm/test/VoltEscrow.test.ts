import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toUtf8Bytes, parseUnits, ZeroAddress } from "ethers";

function channelId(id: string) {
  return keccak256(toUtf8Bytes(id));
}

describe("VoltEscrow", function () {
  async function deployFixture() {
    const [owner, relayer, funder, claimant, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const VoltEscrow = await ethers.getContractFactory("VoltEscrow");
    const escrow = await VoltEscrow.deploy(await usdc.getAddress(), relayer.address);

    await usdc.mint(funder.address, parseUnits("10000", 6));
    await usdc.connect(funder).approve(await escrow.getAddress(), ethers.MaxUint256);

    return { usdc, escrow, owner, relayer, funder, claimant, other };
  }

  it("locks funds, updates channel balance, and records the funder", async function () {
    const { escrow, usdc, funder } = await deployFixture();
    const chn = channelId("chn_1");
    const amount = parseUnits("1000", 6);

    await expect(escrow.connect(funder).lockFunds(chn, amount))
      .to.emit(escrow, "FundsLocked")
      .withArgs(chn, funder.address, amount);

    expect(await escrow.getChannelBalance(chn)).to.equal(amount);
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(amount);
    expect(await escrow.channelFunder(chn)).to.equal(funder.address);
  });

  describe("proposeSettlement / executeSettlement (challenge window)", function () {
    it("only the relayer can propose a settlement", async function () {
      const { escrow, funder, claimant, other } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));

      await expect(
        escrow.connect(other).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release")
      ).to.be.revertedWithCustomError(escrow, "NotRelayer");
    });

    it("cannot execute before the challenge window elapses", async function () {
      const { escrow, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");

      await expect(escrow.executeSettlement(clm)).to.be.revertedWithCustomError(escrow, "StillInChallengeWindow");
    });

    it("executes and pays out once the challenge window has elapsed unopposed, permissionlessly", async function () {
      const { escrow, usdc, relayer, funder, claimant, other } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");

      await time.increase(await escrow.challengeWindow());

      // Executed by an unrelated account -- proves this step is genuinely
      // permissionless, not secretly relayer-gated.
      await expect(escrow.connect(other).executeSettlement(clm))
        .to.emit(escrow, "SettlementExecuted")
        .withArgs(chn, clm, claimant.address, parseUnits("500", 6), "release");

      expect(await usdc.balanceOf(claimant.address)).to.equal(parseUnits("500", 6));
      expect(await escrow.getChannelBalance(chn)).to.equal(parseUnits("500", 6));
    });

    it("the funder can dispute a proposal within the window, blocking execution", async function () {
      const { escrow, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      // A wrong/malicious proposal -- e.g. the relayer misreporting the
      // amount GenLayer actually approved.
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("999", 6), "release");

      await expect(escrow.connect(funder).disputeSettlement(clm))
        .to.emit(escrow, "SettlementDisputed")
        .withArgs(clm, funder.address);

      await time.increase(await escrow.challengeWindow());
      await expect(escrow.executeSettlement(clm)).to.be.revertedWithCustomError(escrow, "SettlementIsDisputed");
    });

    it("only the channel's funder can dispute, not an arbitrary account", async function () {
      const { escrow, relayer, funder, claimant, other } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");

      await expect(escrow.connect(other).disputeSettlement(clm)).to.be.revertedWithCustomError(escrow, "NotChannelFunder");
    });

    it("cannot dispute after the challenge window has already elapsed", async function () {
      const { escrow, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");

      await time.increase(await escrow.challengeWindow());
      await expect(escrow.connect(funder).disputeSettlement(clm)).to.be.revertedWithCustomError(escrow, "ChallengeWindowElapsed");
    });

    it("the relayer can re-propose a corrected settlement after a dispute", async function () {
      const { escrow, usdc, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("999", 6), "release");
      await escrow.connect(funder).disputeSettlement(clm);

      // Corrected proposal, same claimId key.
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");
      await time.increase(await escrow.challengeWindow());
      await escrow.executeSettlement(clm);

      expect(await usdc.balanceOf(claimant.address)).to.equal(parseUnits("500", 6));
    });

    it("cannot propose over an existing, undisputed pending proposal", async function () {
      const { escrow, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");

      await expect(
        escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release")
      ).to.be.revertedWithCustomError(escrow, "PendingSettlementExists");
    });

    it("cannot execute the same settlement twice", async function () {
      const { escrow, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release");
      await time.increase(await escrow.challengeWindow());
      await escrow.executeSettlement(clm);

      await expect(escrow.executeSettlement(clm)).to.be.revertedWithCustomError(escrow, "AlreadyExecuted");
    });

    it("cannot propose more than the channel's locked balance", async function () {
      const { escrow, relayer, funder, claimant } = await deployFixture();
      const chn = channelId("chn_1");
      const clm = channelId("clm_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("100", 6));

      await expect(
        escrow.connect(relayer).proposeSettlement(clm, chn, claimant.address, parseUnits("500", 6), "release")
      ).to.be.revertedWithCustomError(escrow, "InsufficientChannelBalance");
    });

    it("re-checks the channel balance at execution time, not just at proposal time", async function () {
      // Two proposals both pass the balance check at proposal time (since
      // neither has decremented yet); only one can actually execute.
      const { escrow, relayer, funder, claimant, other } = await deployFixture();
      const chn = channelId("chn_1");
      const clmA = channelId("clm_1");
      const clmB = channelId("clm_2");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      await escrow.connect(relayer).proposeSettlement(clmA, chn, claimant.address, parseUnits("700", 6), "release");
      await escrow.connect(relayer).proposeSettlement(clmB, chn, other.address, parseUnits("700", 6), "release");

      await time.increase(await escrow.challengeWindow());
      await escrow.executeSettlement(clmA);
      await expect(escrow.executeSettlement(clmB)).to.be.revertedWithCustomError(escrow, "InsufficientChannelBalance");
    });
  });

  describe("proposeRefund / executeSettlement", function () {
    it("proposes and, after the window, refunds the full remaining channel balance", async function () {
      const { escrow, usdc, relayer, funder } = await deployFixture();
      const chn = channelId("chn_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));

      await escrow.connect(relayer).proposeRefund(chn, funder.address);
      await time.increase(await escrow.challengeWindow());
      await escrow.executeSettlement(chn);

      expect(await escrow.getChannelBalance(chn)).to.equal(0);
      expect(await usdc.balanceOf(funder.address)).to.equal(parseUnits("10000", 6)); // back to starting balance
    });

    it("the funder can dispute a refund proposal too", async function () {
      const { escrow, relayer, funder, other } = await deployFixture();
      const chn = channelId("chn_1");
      await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
      // Wrong recipient -- e.g. a compromised relayer trying to misdirect the refund.
      await escrow.connect(relayer).proposeRefund(chn, other.address);

      await escrow.connect(funder).disputeSettlement(chn);
      await time.increase(await escrow.challengeWindow());
      await expect(escrow.executeSettlement(chn)).to.be.revertedWithCustomError(escrow, "SettlementIsDisputed");
    });
  });

  describe("admin", function () {
    it("only the owner can update the relayer", async function () {
      const { escrow, other } = await deployFixture();
      await expect(escrow.connect(other).setRelayer(other.address)).to.be.revertedWithCustomError(
        escrow,
        "NotOwner"
      );
    });

    it("only the owner can update the challenge window", async function () {
      const { escrow, other } = await deployFixture();
      await expect(escrow.connect(other).setChallengeWindow(3600)).to.be.revertedWithCustomError(escrow, "NotOwner");
    });

    it("owner can lengthen the challenge window", async function () {
      const { escrow, owner } = await deployFixture();
      await escrow.connect(owner).setChallengeWindow(3600);
      expect(await escrow.challengeWindow()).to.equal(3600);
    });

    it("rejects a zero address in the constructor", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      const VoltEscrow = await ethers.getContractFactory("VoltEscrow");
      await expect(VoltEscrow.deploy(await usdc.getAddress(), ZeroAddress)).to.be.revertedWithCustomError(
        VoltEscrow,
        "ZeroAddress"
      );
    });
  });
});
