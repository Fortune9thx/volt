/**
 * Volt's trusted relayer -- the off-chain bridge between GenLayer (the
 * ledger + judge) and Base Sepolia's VoltEscrow (the real USDC vault).
 * See SECURITY.md's "Trust model" for the full disclosure: this relayer
 * has no independent judgment (it only ever executes a channelId/claimId/
 * amount that GenLayer's own multi-validator consensus already decided),
 * but it IS a trusted single point of execution, not a trust-minimized
 * bridge -- there is no light client verifying either chain's state from
 * the other.
 *
 * Stateless by design: every write on both sides is independently
 * idempotent (Volt.py's processed_tx_hashes / claim.relayed guard the
 * GenLayer side; VoltEscrow's claimSettled mapping guards the Base side),
 * so this script can safely re-scan everything on every cycle rather than
 * keeping its own persistent "already handled" database. A crash or
 * restart loses no state and double-processes nothing.
 *
 * Run once (`node scripts/relayer.mjs`) to process everything currently
 * pending, or with --watch to poll continuously.
 */
import "dotenv/config"
import { createClient as createGenlayerClient, createAccount as createGenlayerAccount } from "genlayer-js"
import { testnetBradbury, studionet } from "genlayer-js/chains"
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"

const chainName = process.env.NEXT_PUBLIC_GENLAYER_CHAIN === "studionet" ? "studionet" : "bradbury"
const genlayerChain = chainName === "studionet" ? studionet : testnetBradbury
const voltAddress = process.env.NEXT_PUBLIC_VOLT_CONTRACT_ADDRESS
const escrowAddress = process.env.VOLT_ESCROW_ADDRESS
const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY

if (!voltAddress || !escrowAddress || !relayerPrivateKey) {
  console.error("Set NEXT_PUBLIC_VOLT_CONTRACT_ADDRESS, VOLT_ESCROW_ADDRESS, and RELAYER_PRIVATE_KEY in .env")
  process.exit(1)
}

const genlayerAccount = createGenlayerAccount(relayerPrivateKey)
const genlayer = createGenlayerClient({ chain: genlayerChain, account: genlayerAccount })

const baseAccount = privateKeyToAccount(relayerPrivateKey)
const basePublic = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) })
const baseWallet = createWalletClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL), account: baseAccount })

const ESCROW_ABI = parseAbi([
  "function settle(bytes32 channelId, bytes32 claimId, address recipient, uint256 amount, string kind) external",
  "function refundChannel(bytes32 channelId, address recipient) external returns (uint256)",
  "event FundsLocked(bytes32 indexed channelId, address indexed funder, uint256 amount)",
])

/** Mirrors Volt.py's plain string ids ("chn_1", "clm_1") into the bytes32
 * VoltEscrow uses as its mapping key -- both sides must derive this
 * identically, or a lock/settlement will silently land under the wrong key. */
function toChannelIdBytes32(idString) {
  return keccak256(toHex(idString))
}

async function readAllChannels() {
  const idsJson = await genlayer.readContract({ address: voltAddress, functionName: "get_all_channel_ids", args: [] })
  const ids = JSON.parse(idsJson)
  const channels = []
  for (const id of ids) {
    const raw = await genlayer.readContract({ address: voltAddress, functionName: "get_channel", args: [id] })
    channels.push(JSON.parse(raw))
  }
  return channels
}

async function readAllClaims() {
  const idsJson = await genlayer.readContract({ address: voltAddress, functionName: "get_all_claim_ids", args: [] })
  const ids = JSON.parse(idsJson)
  const claims = []
  for (const id of ids) {
    const raw = await genlayer.readContract({ address: voltAddress, functionName: "get_claim", args: [id] })
    claims.push(JSON.parse(raw))
  }
  return claims
}

/** Leg 1: Base -> GenLayer. Find real FundsLocked events not yet mirrored. */
async function relayLocksToGenlayer() {
  const channels = await readAllChannels()
  const logs = await basePublic.getContractEvents({
    address: escrowAddress,
    abi: ESCROW_ABI,
    eventName: "FundsLocked",
    fromBlock: process.env.RELAYER_FROM_BLOCK ? BigInt(process.env.RELAYER_FROM_BLOCK) : "earliest",
    toBlock: "latest",
  })
  for (const log of logs) {
    const matchingChannel = channels.find((c) => toChannelIdBytes32(c.id) === log.args.channelId)
    if (!matchingChannel) continue
    const txHash = log.transactionHash
    try {
      // Integer BigInt division first, THEN convert to Number -- GenVM's
      // u256 calldata takes a whole-USDC integer (no float type in
      // calldata, matching the "whole GEN" convention proven elsewhere).
      const amountUsdc = Number(log.args.amount / 1_000_000n)
      const hash = await genlayer.writeContract({
        address: voltAddress,
        functionName: "confirm_lock",
        args: [matchingChannel.id, txHash, amountUsdc],
      })
      console.log(`[lock] ${matchingChannel.id} <- ${txHash} (GenLayer tx ${hash})`)
    } catch (err) {
      // TX_ALREADY_PROCESSED is the expected steady-state outcome once a
      // lock has already been relayed -- not an error worth surfacing.
      if (!String(err.message || err).includes("TX_ALREADY_PROCESSED")) {
        console.error(`[lock] failed for ${matchingChannel.id} / ${txHash}:`, err.message || err)
      }
    }
  }
}

/** Leg 2: GenLayer -> Base. Execute already-judged, already-finalized settlements. */
async function relaySettlementsToBase() {
  const claims = await readAllClaims()
  const channels = await readAllChannels()
  for (const claim of claims) {
    if (claim.status !== "executed" || claim.relayed) continue
    const channel = channels.find((c) => c.id === claim.channel_id)
    if (!channel) continue
    const approvedUnits = BigInt(claim.approved_amount_units || "0")
    if (approvedUnits <= 0n) {
      // A "refund"/rejected-with-no-payout claim has nothing to move on
      // Base -- mark it relayed directly with a synthetic reference.
      try {
        const hash = await genlayer.writeContract({
          address: voltAddress, functionName: "mark_relayed",
          args: [claim.id, `no-op:${claim.id}`],
        })
        console.log(`[settle] ${claim.id} needed no Base transfer (GenLayer tx ${hash})`)
      } catch (err) {
        if (!String(err.message || err).includes("TX_ALREADY_PROCESSED")) console.error(`[settle] mark_relayed failed for ${claim.id}:`, err.message || err)
      }
      continue
    }
    try {
      const baseTxHash = await baseWallet.writeContract({
        address: escrowAddress, abi: ESCROW_ABI, functionName: "settle",
        args: [toChannelIdBytes32(channel.id), toChannelIdBytes32(claim.id), claim.claimant, approvedUnits, claim.outcome_type],
      })
      await basePublic.waitForTransactionReceipt({ hash: baseTxHash })
      const genlayerHash = await genlayer.writeContract({
        address: voltAddress, functionName: "mark_relayed", args: [claim.id, baseTxHash],
      })
      console.log(`[settle] ${claim.id} -> ${claim.claimant} (Base tx ${baseTxHash}, GenLayer tx ${genlayerHash})`)
    } catch (err) {
      console.error(`[settle] failed for ${claim.id}:`, err.message || err)
    }
  }
}

/** Leg 3: GenLayer -> Base. Refund channels the funder has closed. */
async function relayClosuresToBase() {
  const channels = await readAllChannels()
  for (const channel of channels) {
    if (channel.status !== "closing") continue
    try {
      const baseTxHash = await baseWallet.writeContract({
        address: escrowAddress, abi: ESCROW_ABI, functionName: "refundChannel",
        args: [toChannelIdBytes32(channel.id), channel.funder],
      })
      await basePublic.waitForTransactionReceipt({ hash: baseTxHash })
      const genlayerHash = await genlayer.writeContract({
        address: voltAddress, functionName: "confirm_channel_closed", args: [channel.id, baseTxHash],
      })
      console.log(`[close] ${channel.id} refunded to ${channel.funder} (Base tx ${baseTxHash}, GenLayer tx ${genlayerHash})`)
    } catch (err) {
      console.error(`[close] failed for ${channel.id}:`, err.message || err)
    }
  }
}

async function runOnce() {
  await relayLocksToGenlayer()
  await relaySettlementsToBase()
  await relayClosuresToBase()
}

const watch = process.argv.includes("--watch")
if (watch) {
  const intervalMs = Number(process.env.RELAYER_POLL_INTERVAL_MS || 15000)
  console.log(`Relayer watching every ${intervalMs}ms...`)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce().catch((err) => console.error("relayer cycle failed:", err))
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
} else {
  await runOnce()
  console.log("Relayer pass complete.")
}
