"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { StatusPill } from "@/components/StatusPill";
import { useWallet } from "@/lib/WalletContext";
import { listClaimsByOwner, unitsToUsdc, type Claim } from "@/lib/genlayer";

export default function Settlements() {
  const { address, connect } = useWallet();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    listClaimsByOwner(address)
      .then((all) => setClaims(all.filter((c) => c.status === "executed" || c.status === "rejected")))
      .catch((err) => setError(err.message));
  }, [address]);

  if (!address) {
    return (
      <AppShell>
        <Card className="text-center py-16 max-w-md mx-auto">
          <h1 className="font-semibold text-xl mb-3">Connect your wallet</h1>
          <p className="text-text-secondary text-sm mb-6">Connect a wallet to view your settlement history.</p>
          <Button onClick={() => connect().catch(() => {})}>Connect Wallet</Button>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="font-semibold text-3xl text-text-primary mb-2">Settlements</h1>
      <p className="text-text-secondary text-sm mb-8">Every finalized claim across your channels — settled or rejected.</p>

      {error && <p className="text-sm text-danger mb-6">{error}</p>}

      {claims === null ? (
        <p className="text-text-muted text-sm">Loading…</p>
      ) : claims.length === 0 ? (
        <Card className="py-12 text-center text-sm text-text-muted">No finalized settlements yet.</Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface shadow-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-text-muted uppercase tracking-wide">
                <th className="px-5 py-3 font-medium">Claim</th>
                <th className="px-5 py-3 font-medium">Channel</th>
                <th className="px-5 py-3 font-medium">Outcome</th>
                <th className="px-5 py-3 font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-alt transition-colors">
                  <td className="px-5 py-3">
                    <Link href={`/claims/${claim.id}`} className="text-blue-500 hover:underline">
                      {claim.id}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-text-secondary">{claim.channel_id}</td>
                  <td className="px-5 py-3">
                    <StatusPill status={claim.outcome_type || claim.status} />
                  </td>
                  <td className="px-5 py-3 text-text-primary font-medium">{unitsToUsdc(claim.approved_amount_units)} USDC</td>
                  <td className="px-5 py-3 text-text-secondary">{claim.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
