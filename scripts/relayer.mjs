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
 * Base-side settlement/refund is a two-step propose -> execute flow
 * separated by VoltEscrow's challengeWindow: this relayer only ever
 * PROPOSES what it read off GenLayer's own finalized verdict, then
 * executes it once the window elapses unopposed. The channel's funder can
 * independently read the same GenLayer record and dispute a wrong
 * proposal before it executes -- if that happens, this relayer just
 * re-proposes the same GenLayer-derived values (it has no separate
 * judgment to fall back on; a repeated dispute means the mismatch needs
 * manual/owner resolution, outside this script's scope).
 *
 * Stateless by design: every write on both sides is independently
 * idempotent (Volt.py's processed_tx_hashes / claim.relayed guard the
 * GenLayer side; VoltEscrow's pendingSettlements guard the Base side), so
 * this script can safely re-scan everything on every cycle rather than
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
  "function proposeSettlement(bytes32 claimId, bytes32 channelId, address recipient, uint256 amount, string kind) external",
  "function proposeRefund(bytes32 channelId, address recipient) external returns (uint256)",
  "function executeSettlement(bytes32 key) external",
  "function challengeWindow() external view returns (uint256)",
  "function getPendingSettlement(bytes32 key) external view returns ((bytes32 channelId, address recipient, uint256 amount, string kind, uint256 proposedAt, bool disputed, bool executed))",
  "event FundsLocked(bytes32 indexed channelId, address indexed funder, uint256 amount)",
])

// Base Sepolia's public RPC caps eth_getLogs at a 10,000-block range per
// call (confirmed live: "eth_getLogs is limited to a 10,000 range") --
// fromBlock: "earliest" silently failed every single cycle. The relayer's
// own stated design re-scans full history every cycle rather than keeping
// a persistent "last scanned block" file (crash-safe, nothing to lose or
// corrupt) -- this preserves that, just chunked to respect the RPC limit.
// RELAYER_DEPLOY_BLOCK overrides the default if VoltEscrow is redeployed.
const ESCROW_DEPLOY_BLOCK = BigInt(process.env.RELAYER_DEPLOY_BLOCK || process.env.RELAYER_FROM_BLOCK || 46292268n)
const GETLOGS_CHUNK_SIZE = 9000n

async function getFundsLockedLogs() {
  const latest = await basePublic.getBlockNumber()
  const logs = []
  for (let from = ESCROW_DEPLOY_BLOCK; from <= latest; from += GETLOGS_CHUNK_SIZE) {
    const to = from + GETLOGS_CHUNK_SIZE - 1n > latest ? latest : from + GETLOGS_CHUNK_SIZE - 1n
    const chunk = await basePublic.getContractEvents({
      address: escrowAddress, abi: ESCROW_ABI, eventName: "FundsLocked",
      fromBlock: from, toBlock: to,
    })
    logs.push(...chunk)
  }
  return logs
}

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
  const logs = await getFundsLockedLogs()
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

/** Leg 2: GenLayer -> Base. Propose, then (after the challenge window)
 * execute, already-judged, already-finalized settlements. */
async function relaySettlementsToBase() {
  const claims = await readAllClaims()
  const channels = await readAllChannels()
  const challengeWindow = await basePublic.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "challengeWindow" })
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))

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

    const claimKey = toChannelIdBytes32(claim.id)
    const channelKey = toChannelIdBytes32(channel.id)
    try {
      const pending = await basePublic.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "getPendingSettlement", args: [claimKey] })

      if (pending.proposedAt === 0n || pending.disputed) {
        // Nothing proposed yet, or the funder disputed a prior proposal --
        // (re-)propose the same values GenLayer's own finalized verdict
        // already decided. This relayer has no separate judgment to fall
        // back on; a repeated dispute needs manual/owner resolution.
        const label = pending.disputed ? "re-propose" : "propose"
        const proposeTx = await baseWallet.writeContract({
          address: escrowAddress, abi: ESCROW_ABI, functionName: "proposeSettlement",
          args: [claimKey, channelKey, claim.claimant, approvedUnits, claim.outcome_type],
        })
        await basePublic.waitForTransactionReceipt({ hash: proposeTx })
        console.log(`[${label}] ${claim.id} -> ${claim.claimant} (Base tx ${proposeTx})`)
        continue
      }
      if (pending.executed) continue // already done -- mark_relayed below will catch up next cycle if it hasn't already
      if (nowSeconds < pending.proposedAt + challengeWindow) continue // still within the challenge window

      const execTx = await baseWallet.writeContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "executeSettlement", args: [claimKey] })
      await basePublic.waitForTransactionReceipt({ hash: execTx })
      const genlayerHash = await genlayer.writeContract({
        address: voltAddress, functionName: "mark_relayed", args: [claim.id, execTx],
      })
      console.log(`[settle] ${claim.id} -> ${claim.claimant} (Base tx ${execTx}, GenLayer tx ${genlayerHash})`)
    } catch (err) {
      console.error(`[settle] failed for ${claim.id}:`, err.message || err)
    }
  }
}

/** Leg 3: GenLayer -> Base. Propose, then (after the challenge window)
 * execute, refunds for channels the funder has closed. */
async function relayClosuresToBase() {
  const channels = await readAllChannels()
  const challengeWindow = await basePublic.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "challengeWindow" })
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))

  for (const channel of channels) {
    if (channel.status !== "closing") continue
    const channelKey = toChannelIdBytes32(channel.id)
    try {
      const pending = await basePublic.readContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "getPendingSettlement", args: [channelKey] })

      if (pending.proposedAt === 0n || pending.disputed) {
        const label = pending.disputed ? "re-propose-refund" : "propose-refund"
        const proposeTx = await baseWallet.writeContract({
          address: escrowAddress, abi: ESCROW_ABI, functionName: "proposeRefund", args: [channelKey, channel.funder],
        })
        await basePublic.waitForTransactionReceipt({ hash: proposeTx })
        console.log(`[${label}] ${channel.id} -> ${channel.funder} (Base tx ${proposeTx})`)
        continue
      }
      if (pending.executed) continue
      if (nowSeconds < pending.proposedAt + challengeWindow) continue

      const execTx = await baseWallet.writeContract({ address: escrowAddress, abi: ESCROW_ABI, functionName: "executeSettlement", args: [channelKey] })
      await basePublic.waitForTransactionReceipt({ hash: execTx })
      const genlayerHash = await genlayer.writeContract({
        address: voltAddress, functionName: "confirm_channel_closed", args: [channel.id, execTx],
      })
      console.log(`[close] ${channel.id} refunded to ${channel.funder} (Base tx ${execTx}, GenLayer tx ${genlayerHash})`)
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
