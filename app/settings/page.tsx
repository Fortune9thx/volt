"use client";

import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { useWallet } from "@/lib/WalletContext";
import { TARGET_CHAIN } from "@/lib/genlayer";

export default function Settings() {
  const { address, connect, disconnect, chainId } = useWallet();

  return (
    <AppShell>
      <h1 className="font-semibold text-3xl text-text-primary mb-8">Settings</h1>

      <div className="max-w-xl space-y-6">
        <Card hover={false}>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Wallet</h2>
          {address ? (
            <div className="space-y-3 text-sm">
              <p className="text-text-secondary">
                Connected <span className="text-text-primary font-mono">{address}</span>
              </p>
              <p className="text-text-secondary">
                Network <span className="text-text-primary">{TARGET_CHAIN.name}</span> (chain id {chainId})
              </p>
              <Button variant="ghost" onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button onClick={() => connect().catch(() => {})}>Connect Wallet</Button>
          )}
        </Card>

        <Card hover={false}>
          <h2 className="text-sm font-semibold text-text-primary mb-2">About Volt</h2>
          <p className="text-sm text-text-secondary leading-relaxed">
            Volt is a GenLayer-native settlement network. Judgment runs on GenLayer&rsquo;s Bradbury testnet via
            multi-validator AI consensus; real USDC is held on Base Sepolia and bridged by a disclosed trusted
            relayer. See{" "}
            <a href="https://github.com" className="text-blue-500 hover:underline">
              SECURITY.md
            </a>{" "}
            for the full trust model.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
