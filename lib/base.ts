import { createWalletClient, createPublicClient, custom, http, parseUnits, keccak256, toHex, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { getActiveProvider } from "./genlayer";

const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_VOLT_ESCROW_ADDRESS as Address | undefined;
const USDC_ADDRESS = process.env.NEXT_PUBLIC_BASE_SEPOLIA_USDC_ADDRESS as Address | undefined;

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "lockFunds", stateMutability: "nonpayable", inputs: [{ name: "channelId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

/** Volt's channel/claim ids ("chn_1") must hash to the SAME bytes32 key on
 * both sides of the bridge -- the relayer derives it identically. */
export function toChannelIdBytes32(idString: string) {
  return keccak256(toHex(idString));
}

function requireConfig() {
  if (!ESCROW_ADDRESS) throw new Error("NEXT_PUBLIC_VOLT_ESCROW_ADDRESS is not set");
  if (!USDC_ADDRESS) throw new Error("NEXT_PUBLIC_BASE_SEPOLIA_USDC_ADDRESS is not set");
  return { escrow: ESCROW_ADDRESS, usdc: USDC_ADDRESS };
}

async function getBaseWalletClient(account: Address) {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet connected");
  const client = createWalletClient({ chain: baseSepolia, transport: custom(provider as never), account });
  // The same injected wallet used for GenLayer must also switch to Base
  // Sepolia before signing a Base-side transaction -- these are two
  // completely separate chains, not something genlayer-js's own chain
  // switch handles.
  try {
    await client.switchChain({ id: baseSepolia.id });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await (provider as { request: (args: unknown) => Promise<unknown> }).request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: `0x${baseSepolia.id.toString(16)}`,
          chainName: baseSepolia.name,
          nativeCurrency: baseSepolia.nativeCurrency,
          rpcUrls: [baseSepolia.rpcUrls.default.http[0]],
          blockExplorerUrls: [baseSepolia.blockExplorers.default.url],
        },
      ],
    });
  }
  return client;
}

function getBasePublicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http() });
}

/** Locks real USDC on Base Sepolia against a channel. Approves the escrow
 * contract first if the current allowance is insufficient, then calls
 * lockFunds. Returns the lockFunds transaction hash -- the relayer picks
 * this up and mirrors it into GenLayer's ledger via confirm_lock. */
export async function lockFundsOnBase(account: Address, channelId: string, amountUsdc: number): Promise<`0x${string}`> {
  const { escrow, usdc } = requireConfig();
  const wallet = await getBaseWalletClient(account);
  const publicClient = getBasePublicClient();
  const amountUnits = parseUnits(String(amountUsdc), 6);

  const allowance = await publicClient.readContract({
    address: usdc, abi: ERC20_ABI, functionName: "allowance", args: [account, escrow],
  });
  if (allowance < amountUnits) {
    const approveHash = await wallet.writeContract({ address: usdc, abi: ERC20_ABI, functionName: "approve", args: [escrow, amountUnits] });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const hash = await wallet.writeContract({
    address: escrow, abi: ESCROW_ABI, functionName: "lockFunds", args: [toChannelIdBytes32(channelId), amountUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function getUsdcBalance(account: Address): Promise<bigint> {
  const { usdc } = requireConfig();
  const publicClient = getBasePublicClient();
  return publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
}
