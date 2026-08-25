"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { StatusPill } from "@/components/StatusPill";
import { useWallet } from "@/lib/WalletContext";
import { listChannelsByParty, listClaimsByOwner, unitsToUsdc, type Channel, type Claim } from "@/lib/genlayer";

export default function Dashboard() {
  const { address, connect } = useWallet();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    setError(null);
    Promise.all([listChannelsByParty(address), listClaimsByOwner(address)])
      .then(([c, cl]) => {
        setChannels(c);
        setClaims(cl);
      })
      .catch((err) => setError(err.message || "Failed to load dashboard"));
  }, [address]);

  if (!address) {
    return (
      <AppShell>
        <Card className="text-center py-16 max-w-md mx-auto">
          <h1 className="font-semibold text-xl mb-3">Connect your wallet</h1>
          <p className="text-text-secondary text-sm mb-6">
            Connect a wallet on GenLayer Bradbury to view your Volt channels and claims.
          </p>
          <Button onClick={() => connect().catch(() => {})}>Connect Wallet</Button>
        </Card>
      </AppShell>
    );
  }

  const activeClaims = claims?.filter((c) => c.status === "pending" || c.status === "judged") ?? [];
  const settledClaims = claims?.filter((c) => c.status === "executed") ?? [];

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-semibold text-3xl text-text-primary mb-1">Dashboard</h1>
          <p className="text-text-secondary text-sm">Your Volt channels, claims, and settlements.</p>
        </div>
        <Link href="/channels/new">
          <Button>New Channel</Button>
        </Link>
      </div>

      {error && <p className="text-sm text-danger mb-6">{error}</p>}

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">Channels</h2>
        {channels === null ? (
          <p className="text-text-muted text-sm">Loading…</p>
        ) : channels.length === 0 ? (
          <Card className="text-center py-12">
            <p className="text-text-secondary text-sm mb-4">You don&rsquo;t have any channels yet.</p>
            <Link href="/channels/new">
              <Button size="md">Create your first channel</Button>
            </Link>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {channels.map((channel) => (
              <Link key={channel.id} href={`/channels/${channel.id}`}>
                <Card className="h-full">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-medium text-text-muted">{channel.id}</span>
                    <StatusPill status={channel.status} />
                  </div>
                  <p className="text-sm text-text-primary leading-relaxed line-clamp-3 mb-4">{channel.mandate}</p>
                  <p className="text-sm text-text-secondary">
                    Balance <span className="text-text-primary font-medium">{unitsToUsdc(channel.balance_units)} USDC</span>
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">Active claims</h2>
        {activeClaims.length === 0 ? (
          <Card className="py-8 text-center text-sm text-text-muted">No active claims.</Card>
        ) : (
          <div className="space-y-3">
            {activeClaims.map((claim) => (
              <Link key={claim.id} href={`/claims/${claim.id}`}>
                <Card className="flex items-center justify-between py-4">
                  <div>
                    <span className="text-xs text-text-muted">{claim.id}</span>
                    <p className="text-sm text-text-primary">{unitsToUsdc(claim.requested_amount_units)} USDC requested</p>
                  </div>
                  <StatusPill status={claim.status} />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">Recent settlements</h2>
        {settledClaims.length === 0 ? (
          <Card className="py-8 text-center text-sm text-text-muted">No settlements yet.</Card>
        ) : (
          <div className="space-y-3">
            {settledClaims.map((claim) => (
              <Link key={claim.id} href={`/claims/${claim.id}`}>
                <Card className="flex items-center justify-between py-4">
                  <div>
                    <span className="text-xs text-text-muted">{claim.id}</span>
                    <p className="text-sm text-text-primary">{unitsToUsdc(claim.approved_amount_units)} USDC settled</p>
                  </div>
                  <StatusPill status={claim.outcome_type || claim.status} />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
