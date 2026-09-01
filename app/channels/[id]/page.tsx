"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { StatusPill } from "@/components/StatusPill";
import { FormField, Input } from "@/components/FormField";
import { useWallet } from "@/lib/WalletContext";
import { getChannel, listClaimsByChannel, closeChannel, unitsToUsdc, formatWriteStatus, type Channel, type Claim } from "@/lib/genlayer";
import { lockFundsOnBase } from "@/lib/base";
import type { Address } from "viem";

export default function ChannelDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { address } = useWallet();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lockAmount, setLockAmount] = useState("");
  const [locking, setLocking] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeStatus, setCloseStatus] = useState<string | null>(null);
  const [lockSuccess, setLockSuccess] = useState<string | null>(null);

  const load = useCallback(() => {
    getChannel(id).then(setChannel).catch((err) => setError(err.message));
    listClaimsByChannel(id).then(setClaims).catch(() => {});
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLock = async () => {
    if (!address || !lockAmount) return;
    setError(null);
    setLockSuccess(null);
    setLocking(true);
    try {
      const amountLocked = lockAmount;
      await lockFundsOnBase(address as Address, id, Number(lockAmount));
      setLockAmount("");
      // The relayer needs a moment to observe and mirror the lock -- load()
      // here would just show the same stale balance, since the mirror
      // hasn't landed yet. A clear success message stands in for that gap
      // instead of leaving the form looking like nothing happened.
      setLockSuccess(
        `Locked ${amountLocked} USDC on Base. Volt's relayer mirrors this into the channel within ~15-20s -- refresh in a moment to see the updated balance.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to lock funds on Base");
    } finally {
      setLocking(false);
    }
  };

  const handleClose = async () => {
    setClosing(true);
    setError(null);
    setCloseStatus(formatWriteStatus("SUBMITTED"));
    try {
      await closeChannel(id, (statusName) => setCloseStatus(formatWriteStatus(statusName)));
      load();
      setCloseStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close channel");
      setCloseStatus(null);
    } finally {
      setClosing(false);
    }
  };

  if (!channel) {
    return (
      <AppShell>
        <p className="text-text-muted text-sm">{error || "Loading…"}</p>
      </AppShell>
    );
  }

  const isFunder = address === channel.funder;

  return (
    <AppShell>
      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <Card hover={false}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-text-muted">{channel.id}</span>
              <StatusPill status={channel.status} />
            </div>
            <p className="text-[15px] leading-relaxed text-text-primary">&ldquo;{channel.mandate}&rdquo;</p>
          </Card>

          <div className="flex flex-wrap gap-6 items-center">
            <span className="text-sm text-text-secondary">
              Balance <span className="text-text-primary font-medium">{unitsToUsdc(channel.balance_units)} USDC</span>
            </span>
            <span className="text-sm text-text-secondary">
              Total settled <span className="text-text-primary font-medium">{unitsToUsdc(channel.total_settled_units)} USDC</span>
            </span>
            <span className="text-sm text-text-secondary">
              Expiry <span className="text-text-primary font-medium">{channel.expiry}</span>
            </span>
          </div>

          <div className="flex gap-4">
            {channel.status === "active" && (
              <Link href={`/claims/new?channelId=${channel.id}`}>
                <Button>Submit Claim</Button>
              </Link>
            )}
            {isFunder && channel.status === "active" && (
              <Button variant="ghost" onClick={handleClose} disabled={closing}>
                {closing ? "Closing…" : "Close Channel"}
              </Button>
            )}
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
          {closeStatus && <p className="text-sm text-text-secondary">{closeStatus}</p>}

          <div>
            <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">Claims</h2>
            {claims.length === 0 ? (
              <Card className="py-8 text-center text-sm text-text-muted">No claims submitted yet.</Card>
            ) : (
              <div className="space-y-3">
                {claims.map((claim) => (
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
          </div>
        </div>

        <div className="space-y-6">
          {channel.status === "active" && (
            <Card hover={false}>
              <h3 className="text-sm font-semibold text-text-primary mb-1">Lock funds on Base</h3>
              <p className="text-xs text-text-muted mb-4 leading-relaxed">
                Real USDC is locked on Base Sepolia, not GenLayer. Volt&rsquo;s relayer mirrors the lock here
                automatically within a few moments.
              </p>
              <FormField label="Amount (USDC)">
                <Input type="number" min="1" placeholder="1000" value={lockAmount} onChange={(e) => setLockAmount(e.target.value)} />
              </FormField>
              <Button className="w-full mt-4" onClick={handleLock} disabled={locking || !lockAmount || !address}>
                {locking ? "Locking on Base…" : "Lock Funds"}
              </Button>
              {lockSuccess && <p className="mt-3 text-xs text-teal-600 leading-relaxed">{lockSuccess}</p>}
            </Card>
          )}
          <Card hover={false} className="text-xs text-text-muted space-y-2">
            <p>
              <span className="font-medium text-text-primary">Funder</span> {channel.funder}
            </p>
            <p>
              <span className="font-medium text-text-primary">Parties</span> {channel.parties}
            </p>
          </Card>
          <Button variant="ghost" className="w-full" onClick={() => router.push("/dashboard")}>
            Back to Dashboard
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
