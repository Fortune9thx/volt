import { expect } from "chai";
import { ethers } from "hardhat";
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

  it("locks funds and updates channel balance", async function () {
    const { escrow, usdc, funder } = await deployFixture();
    const chn = channelId("chn_1");
    const amount = parseUnits("1000", 6);

    await expect(escrow.connect(funder).lockFunds(chn, amount))
      .to.emit(escrow, "FundsLocked")
      .withArgs(chn, funder.address, amount);

    expect(await escrow.getChannelBalance(chn)).to.equal(amount);
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(amount);
  });

  it("only the relayer can settle a claim", async function () {
    const { escrow, funder, claimant, other } = await deployFixture();
    const chn = channelId("chn_1");
    const clm = channelId("clm_1");
    await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));

    await expect(
      escrow.connect(other).settle(chn, clm, claimant.address, parseUnits("500", 6), "release")
    ).to.be.revertedWithCustomError(escrow, "NotRelayer");
  });

  it("settles a full release and decrements the channel balance", async function () {
    const { escrow, usdc, relayer, funder, claimant } = await deployFixture();
    const chn = channelId("chn_1");
    const clm = channelId("clm_1");
    await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));

    await expect(
      escrow.connect(relayer).settle(chn, clm, claimant.address, parseUnits("500", 6), "release")
    )
      .to.emit(escrow, "SettlementExecuted")
      .withArgs(chn, clm, claimant.address, parseUnits("500", 6), "release");

    expect(await usdc.balanceOf(claimant.address)).to.equal(parseUnits("500", 6));
    expect(await escrow.getChannelBalance(chn)).to.equal(parseUnits("500", 6));
  });

  it("cannot settle the same claim twice", async function () {
    const { escrow, relayer, funder, claimant } = await deployFixture();
    const chn = channelId("chn_1");
    const clm = channelId("clm_1");
    await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));
    await escrow.connect(relayer).settle(chn, clm, claimant.address, parseUnits("500", 6), "release");

    await expect(
      escrow.connect(relayer).settle(chn, clm, claimant.address, parseUnits("500", 6), "release")
    ).to.be.revertedWithCustomError(escrow, "ClaimAlreadySettled");
  });

  it("cannot settle more than the channel's locked balance", async function () {
    const { escrow, relayer, funder, claimant } = await deployFixture();
    const chn = channelId("chn_1");
    const clm = channelId("clm_1");
    await escrow.connect(funder).lockFunds(chn, parseUnits("100", 6));

    await expect(
      escrow.connect(relayer).settle(chn, clm, claimant.address, parseUnits("500", 6), "release")
    ).to.be.revertedWithCustomError(escrow, "InsufficientChannelBalance");
  });

  it("refunds the full remaining channel balance on close", async function () {
    const { escrow, usdc, relayer, funder } = await deployFixture();
    const chn = channelId("chn_1");
    await escrow.connect(funder).lockFunds(chn, parseUnits("1000", 6));

    await escrow.connect(relayer).refundChannel(chn, funder.address);

    expect(await escrow.getChannelBalance(chn)).to.equal(0);
    expect(await usdc.balanceOf(funder.address)).to.equal(parseUnits("10000", 6)); // back to starting balance
  });

  it("only the owner can update the relayer", async function () {
    const { escrow, other } = await deployFixture();
    await expect(escrow.connect(other).setRelayer(other.address)).to.be.revertedWithCustomError(
      escrow,
      "NotOwner"
    );
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
