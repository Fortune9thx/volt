"use client";

import { useWallet } from "@/lib/WalletContext";
import { Button } from "./Button";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton({ dark = false }: { dark?: boolean }) {
  const { address, connecting, connect, disconnect, wrongChain, switchChain, switchingChain, targetChainName, error } = useWallet();

  if (!address) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="md" onClick={() => connect().catch(() => {})} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect Wallet"}
        </Button>
        {error && <span className="text-xs text-danger max-w-48 text-right">{error}</span>}
      </div>
    );
  }

  if (wrongChain) {
    return (
      <Button size="md" variant="secondary" onClick={() => switchChain().catch(() => {})} disabled={switchingChain}>
        {switchingChain ? "Switching…" : `Switch to ${targetChainName}`}
      </Button>
    );
  }

  return (
    <button
      onClick={disconnect}
      className={
        dark
          ? "flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-text-on-dark hover:bg-white/5 transition-colors"
          : "flex items-center gap-2 rounded-full border border-border-subtle px-4 py-2 text-sm text-text-primary hover:bg-surface-alt transition-colors"
      }
      title="Click to disconnect"
    >
      <span className="h-2 w-2 rounded-full bg-success" />
      {shortAddress(address)}
    </button>
  );
}
