import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury, studionet } from "genlayer-js/chains";
import { TransactionStatus, ExecutionResult, type CalldataEncodable, type Address } from "genlayer-js/types";

const CHAIN = process.env.NEXT_PUBLIC_GENLAYER_CHAIN === "studionet" ? studionet : testnetBradbury;
const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_VOLT_CONTRACT_ADDRESS;

export const TARGET_CHAIN = CHAIN;
export const TARGET_CHAIN_ID = CHAIN.id;

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] };
    okxwallet?: Eip1193Provider;
    coinbaseWalletExtension?: Eip1193Provider;
  }
}

/**
 * Discovers the wallet provider to use. Modern multi-wallet browsers (OKX
 * Wallet, Coinbase Wallet, Rabby, etc.) often don't set the legacy
 * `window.ethereum` global unless made the browser's default -- they
 * announce via EIP-6963 instead. Checks EIP-6963 first, falls back to
 * legacy globals. Proven pattern from a prior GenLayer build's real OKX
 * Wallet "no wallet found" bug fix.
 */
async function discoverProviders(): Promise<Eip1193Provider[]> {
  const found: Eip1193Provider[] = [];
  const handleAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<{ provider: Eip1193Provider }>).detail;
    if (detail?.provider) found.push(detail.provider);
  };
  window.addEventListener("eip6963:announceProvider", handleAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.removeEventListener("eip6963:announceProvider", handleAnnounce);
  if (found.length > 0) return found;

  const legacy: Eip1193Provider[] = [];
  if (window.ethereum?.providers?.length) legacy.push(...window.ethereum.providers);
  else if (window.ethereum) legacy.push(window.ethereum);
  if (window.okxwallet) legacy.push(window.okxwallet);
  if (window.coinbaseWalletExtension) legacy.push(window.coinbaseWalletExtension);
  return legacy;
}

let activeProvider: Eip1193Provider | null = null;
let clientPromise: Promise<ReturnType<typeof createClient>> | null = null;

export function getActiveProvider() {
  return activeProvider;
}

export function disconnectWallet() {
  activeProvider = null;
  clientPromise = null;
}

export async function getWalletChainId(): Promise<number | null> {
  if (!activeProvider) return null;
  const hex = (await activeProvider.request({ method: "eth_chainId" })) as string;
  return parseInt(hex, 16);
}

export async function switchToTargetChain() {
  if (!activeProvider) throw new Error("No wallet found.");
  const chainIdHex = `0x${TARGET_CHAIN_ID.toString(16)}`;
  try {
    await activeProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await activeProvider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: TARGET_CHAIN.name,
          nativeCurrency: TARGET_CHAIN.nativeCurrency,
          rpcUrls: TARGET_CHAIN.rpcUrls.default.http,
          blockExplorerUrls: TARGET_CHAIN.blockExplorers ? [TARGET_CHAIN.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

function getReadOnlyAccount() {
  return createAccount();
}

export async function connectWallet(): Promise<string> {
  const providers = await discoverProviders();
  if (providers.length === 0) {
    throw new Error("No wallet found. Install a browser wallet (MetaMask, OKX Wallet, Coinbase Wallet, etc.) to create or manage channels.");
  }
  const provider = providers[0];
  const [address] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  activeProvider = provider;
  const chainId = await getWalletChainId();
  if (chainId !== TARGET_CHAIN_ID) await switchToTargetChain();
  const client = createClient({ chain: CHAIN, account: address as `0x${string}`, provider });
  clientPromise = Promise.resolve(client);
  return address;
}

async function getClient() {
  if (clientPromise) return clientPromise;
  const client = createClient({ chain: CHAIN, account: getReadOnlyAccount() });
  clientPromise = Promise.resolve(client);
  return clientPromise;
}

function requireContractAddress(): Address {
  if (!CONTRACT_ADDRESS) {
    throw new Error("NEXT_PUBLIC_VOLT_CONTRACT_ADDRESS is not set -- deploy contracts/Volt.py and add its address to .env");
  }
  return CONTRACT_ADDRESS as Address;
}

const ERROR_MESSAGES: Record<string, string> = {
  CHANNEL_NOT_FOUND: "That channel could not be found.",
  CHANNEL_NOT_ACTIVE: "This channel is not active.",
  CHANNEL_NOT_CLOSING: "This channel isn't in the process of closing.",
  CHANNEL_HAS_UNRESOLVED_CLAIMS: "This channel has a claim that hasn't been judged or executed yet — resolve it before closing.",
  NOT_CHANNEL_FUNDER: "You're not the funder of this channel.",
  CLAIM_NOT_FOUND: "That claim could not be found.",
  CLAIM_ALREADY_JUDGED: "This claim has already been judged.",
  CLAIM_NOT_JUDGED: "This claim hasn't been judged yet.",
  CLAIM_NOT_EXECUTED: "This claim hasn't been executed yet.",
  CLAIM_ALREADY_RELAYED: "This settlement has already been relayed to Base.",
  NOT_AUTHORIZED_TO_EXECUTE: "Only the channel funder, the claimant, or Volt may execute this settlement.",
  NOT_RELAYER: "Only Volt's relayer may perform this action.",
  NOT_OWNER: "Only the contract owner may perform this action.",
  CONTRACT_PAUSED: "Volt is temporarily paused for maintenance.",
  TX_ALREADY_PROCESSED: "This transaction has already been processed.",
  INVALID_MANDATE: "A Settlement Mandate is required.",
  INVALID_PARTIES: "At least one party address is required.",
  INVALID_EXPIRY: "Enter a valid expiry date.",
  INVALID_EVIDENCE: "Evidence is required.",
  INVALID_REQUESTED_AMOUNT: "Enter a valid requested amount.",
  REQUESTED_AMOUNT_EXCEEDS_CHANNEL_BALANCE: "The requested amount exceeds this channel's locked balance.",
  NOT_CHANNEL_PARTY: "You're not the funder or a listed party on this channel.",
  INVALID_SETTLEMENT_AMOUNT: "Invalid settlement amount.",
};

/**
 * GenLayer RPC errors from a reverted contract call surface as a raw GenVM
 * execution dump. The UserError's own code string is in there as a
 * comma-separated list of hex byte values -- decode those bytes back to a
 * string first, then extract the code and map it to friendly copy.
 */
export function friendlyContractError(err: unknown): Error {
  const raw = (err as { message?: string })?.message || String(err);
  // A client-side polling-budget timeout (genlayer-js's own
  // waitForTransactionReceipt giving up) is not a GenVM revert dump -- the
  // regex below would otherwise extract "FINALIZED" out of this message
  // and mangle it into the single word "finalized", hiding the real,
  // actionable fact that the transaction may already have succeeded.
  if (raw.includes("Timed out waiting for transaction")) {
    return new Error(
      "Bradbury is taking longer than usual to finalize this transaction. It may have already succeeded -- please wait a moment and refresh."
    );
  }
  const hexBytes = [...raw.matchAll(/0x([0-9a-fA-F]{1,2})\b/g)].map((m) => parseInt(m[1], 16));
  const decoded = hexBytes.length > 0 ? String.fromCharCode(...hexBytes) : "";
  const match = decoded.match(/\b([A-Z][A-Z0-9_]{4,})\b/) || raw.match(/\b([A-Z][A-Z0-9_]{4,})\b/);
  const code = match?.[1];
  if (code && ERROR_MESSAGES[code]) return new Error(ERROR_MESSAGES[code]);
  if (code) return new Error(code.replace(/_/g, " ").toLowerCase());
  return err instanceof Error ? err : new Error(raw);
}

async function readContract<T = unknown>(functionName: string, args: CalldataEncodable[] = []): Promise<T> {
  const client = await getClient();
  try {
    return (await client.readContract({ address: requireContractAddress(), functionName, args })) as T;
  } catch (err) {
    throw friendlyContractError(err);
  }
}

async function writeContract(functionName: string, args: CalldataEncodable[] = []): Promise<string> {
  const client = await getClient();
  let hash: Awaited<ReturnType<typeof client.writeContract>>;
  let receipt: Awaited<ReturnType<typeof client.waitForTransactionReceipt>>;
  try {
    hash = await client.writeContract({ address: requireContractAddress(), functionName, args, value: BigInt(0) });
    // The SDK's own default wait budget (10 retries x 3s = 30s) is far
    // shorter than Bradbury's known finalization lag -- FINALIZED settles
    // the appeal window and can take several minutes even for a write
    // that already succeeded. A too-short budget here doesn't make a
    // write any safer, it just surfaces a false, misleading timeout for
    // calls that were actually fine. ~8 minutes matches the budget already
    // proven necessary for this same network characteristic elsewhere.
    receipt = await client.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, interval: 5000, retries: 100 });
  } catch (err) {
    throw friendlyContractError(err);
  }
  // waitForTransactionReceipt only confirms consensus reached the
  // requested STATUS (FINALIZED) -- it never checks whether the contract's
  // own execution actually succeeded. Consensus can validly finalize an
  // AGREEMENT that a call reverted (e.g. a gl.vm.UserError inside
  // judge_claim/execute_settlement), which would otherwise be silently
  // treated as success here. Same class of gap GenLayer review flagged on
  // a sibling project's decision-critical write flow -- and that review
  // caught a subtler version of this exact check done wrong: gating on
  // `!== FINISHED_WITH_ERROR` (a deny-list) treats a MISSING or NOT_VOTED
  // result as success too, since neither equals FINISHED_WITH_ERROR. This
  // must be an allow-list instead -- require the result to be truthy AND
  // exactly FINISHED_WITH_RETURN; anything else (ERROR, NOT_VOTED, or
  // simply absent) fails closed, since FINALIZED implies execution has
  // already happened and a real result should always be present by then.
  if (receipt.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
    throw new Error("Transaction was finalized, but its execution did not succeed.");
  }
  return hash;
}

export interface Channel {
  id: string;
  mandate: string;
  parties: string;
  funder: string;
  balance_units: string;
  total_locked_units: string;
  total_settled_units: string;
  expiry: string;
  status: "active" | "closing" | "closed";
}

export interface Claim {
  id: string;
  channel_id: string;
  claimant: string;
  evidence: string;
  requested_amount_units: string;
  status: "pending" | "rejected" | "judged" | "executed";
  outcome_type: "" | "full" | "partial" | "refund";
  approved_amount_units: string;
  reasoning: string;
  confidence: string;
  relayed: boolean;
  base_tx_hash: string;
  verified_facts?: { fetch_ok: boolean; supports_claim: boolean; facts_summary: string };
}

export const USDC_UNIT = 1_000_000;

export function unitsToUsdc(units: string | number): number {
  return Math.floor(Number(units) / USDC_UNIT);
}

export async function createChannel(params: { mandate: string; parties: string; expiry: string }): Promise<string> {
  return writeContract("create_channel", [params.mandate, params.parties, params.expiry]);
}

export async function getChannel(channelId: string): Promise<Channel> {
  const raw = await readContract<string>("get_channel", [channelId]);
  return JSON.parse(raw);
}

export async function listChannelsByParty(address: string): Promise<Channel[]> {
  const raw = await readContract<string>("list_channels_by_party", [address]);
  return JSON.parse(raw);
}

export async function getAllChannelIds(): Promise<string[]> {
  const raw = await readContract<string>("get_all_channel_ids", []);
  return JSON.parse(raw);
}

export async function closeChannel(channelId: string): Promise<string> {
  return writeContract("close_channel", [channelId]);
}

export async function submitClaim(params: { channelId: string; evidence: string; requestedAmountUsdc: number }): Promise<string> {
  return writeContract("submit_claim", [params.channelId, params.evidence, params.requestedAmountUsdc]);
}

export async function judgeClaim(claimId: string): Promise<string> {
  return writeContract("judge_claim", [claimId]);
}

export async function executeSettlement(claimId: string): Promise<string> {
  return writeContract("execute_settlement", [claimId]);
}

export async function getClaim(claimId: string): Promise<Claim> {
  const raw = await readContract<string>("get_claim", [claimId]);
  return JSON.parse(raw);
}

export async function listClaimsByChannel(channelId: string): Promise<Claim[]> {
  const raw = await readContract<string>("list_claims_by_channel", [channelId]);
  return JSON.parse(raw);
}

/** No contract-level list_claims_by_owner view exists (claims are indexed
 * by channel, not by claimant), so this aggregates client-side. */
export async function listClaimsByOwner(owner: string): Promise<Claim[]> {
  const channels = await listChannelsByParty(owner);
  const claimLists = await Promise.all(channels.map((c) => listClaimsByChannel(c.id)));
  return claimLists.flat();
}
