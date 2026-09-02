import { ethers } from "hardhat";

// Base Sepolia's official Circle-issued USDC test token address must be
// verified against Circle's own docs/Base's official token list at deploy
// time (https://developers.circle.com/stablecoins/usdc-on-test-networks)
// rather than hardcoded here from memory -- a stale or wrong address would
// silently point the whole escrow at the wrong asset.
const USDC_ADDRESS = process.env.BASE_SEPOLIA_USDC_ADDRESS;

async function main() {
  if (!USDC_ADDRESS) {
    throw new Error(
      "Set BASE_SEPOLIA_USDC_ADDRESS in evm/.env to Base Sepolia's verified USDC address before deploying."
    );
  }
  const [deployer] = await ethers.getSigners();
  const relayerAddress = process.env.RELAYER_ADDRESS || deployer.address;

  console.log(`Deploying VoltEscrow from ${deployer.address}`);
  console.log(`  usdc:    ${USDC_ADDRESS}`);
  console.log(`  relayer: ${relayerAddress}`);

  const VoltEscrow = await ethers.getContractFactory("VoltEscrow");
  const escrow = await VoltEscrow.deploy(USDC_ADDRESS, relayerAddress);
  await escrow.waitForDeployment();

  const deployTx = escrow.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  console.log(`VoltEscrow deployed to: ${await escrow.getAddress()}`);
  if (receipt) console.log(`Deployment block: ${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
