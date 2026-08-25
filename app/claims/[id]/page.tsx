"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { StatusPill } from "@/components/StatusPill";
import { getClaim, judgeClaim, executeSettlement, unitsToUsdc, type Claim } from "@/lib/genlayer";

const STEPS = ["Submitted", "Evidence fetched", "Judged", "Executed"] as const;

function currentStepIndex(claim: Claim): number {
  if (claim.status === "pending") return 0;
  if (claim.status === "rejected") return 1;
  if (claim.status === "judged") return 2;
  if (claim.status === "executed") return 3;
  return 0;
}

export default function ClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(() => {
    getClaim(id).then(setClaim).catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleJudge = async () => {
    setJudging(true);
    setError(null);
    try {
      await judgeClaim(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Judgment failed");
    } finally {
      setJudging(false);
    }
  };

  const handleExecute = async () => {
    setExecuting(true);
    setError(null);
    try {
      await executeSettlement(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setExecuting(false);
    }
  };

  if (!claim) {
    return (
      <AppShell>
        <p className="text-text-muted text-sm">{error || "Loading…"}</p>
      </AppShell>
    );
  }

  const step = currentStepIndex(claim);
  const isRejected = claim.status === "rejected";

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <span className="text-xs text-text-muted">{claim.id}</span>
            <h1 className="font-semibold text-2xl text-text-primary">Settlement Judgment</h1>
          </div>
          <StatusPill status={isRejected ? "rejected" : claim.status} />
        </div>

        <Card hover={false} className="mb-8">
          <div className="flex items-center justify-between">
            {STEPS.map((label, i) => (
              <div key={label} className="flex-1 flex flex-col items-center relative">
                {i > 0 && (
                  <div
                    className={`absolute top-3.5 right-1/2 w-full h-0.5 -z-10 ${
                      i <= step && !(isRejected && i > 1) ? "bg-teal-500" : "bg-border-subtle"
                    }`}
                  />
                )}
                <div
                  className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ${
                    i < step || (i === step && (i === 3 || (isRejected && i === 1)))
                      ? "bg-teal-500 text-white"
                      : i === step
                        ? "bg-orange-500 text-white"
                        : "bg-surface-sunken text-text-muted"
                  }`}
                >
                  {i + 1}
                </div>
                <span className="mt-2 text-[11px] text-text-muted text-center">{isRejected && i === 1 ? "Rejected" : label}</span>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-6">
          <Card hover={false}>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Evidence submitted</p>
            <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{claim.evidence}</p>
          </Card>

          {claim.verified_facts && (
            <Card hover={false} className="border-teal-500/30">
              <p className="text-xs font-medium text-teal-600 uppercase tracking-wide mb-2">Verified facts (Stage A)</p>
              <p className="text-sm text-text-primary leading-relaxed">{claim.verified_facts.facts_summary}</p>
              <p className="mt-2 text-xs text-text-muted">
                {claim.verified_facts.supports_claim ? "Supports the claim" : "Does not support the claim"} — independently
                fetched and re-verified by two validators before any judgment ran.
              </p>
            </Card>
          )}

          {claim.status !== "pending" && (
            <Card hover={false} className={isRejected || claim.outcome_type === "refund" ? "border-border-subtle" : "border-teal-500/30"}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Verdict (Stage B)</p>
                {claim.outcome_type && <StatusPill status={claim.outcome_type} />}
              </div>
              <p className="text-sm text-text-primary leading-relaxed mb-3">{claim.reasoning}</p>
              <div className="flex gap-6 text-xs text-text-muted">
                <span>
                  Confidence <span className="text-text-primary font-medium">{claim.confidence}</span>
                </span>
                <span>
                  Approved <span className="text-text-primary font-medium">{unitsToUsdc(claim.approved_amount_units)} USDC</span>
                </span>
              </div>
            </Card>
          )}

          {claim.relayed && (
            <Card hover={false} className="bg-surface-alt">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Relayed to Base</p>
              <p className="text-xs text-text-secondary break-all">{claim.base_tx_hash}</p>
            </Card>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-4">
            {claim.status === "pending" && (
              <Button onClick={handleJudge} disabled={judging}>
                {judging ? "Judging…" : "Judge Claim"}
              </Button>
            )}
            {claim.status === "judged" && (
              <Button onClick={handleExecute} disabled={executing}>
                {executing ? "Executing…" : "Execute Settlement"}
              </Button>
            )}
            <Link href={`/channels/${claim.channel_id}`}>
              <Button variant="ghost">Back to Channel</Button>
            </Link>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
