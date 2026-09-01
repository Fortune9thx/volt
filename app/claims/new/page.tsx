"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { FormField, Input, Textarea } from "@/components/FormField";
import { Button } from "@/components/Button";
import { useWallet } from "@/lib/WalletContext";
import { submitClaim, formatWriteStatus } from "@/lib/genlayer";
import { validate, isValidWholeUsdcAmount } from "@/lib/validation";

interface ClaimForm {
  evidence: string;
  requestedAmountUsdc: string;
}

const CHECKS: Array<[keyof ClaimForm, (v: unknown, all: ClaimForm) => boolean, string]> = [
  ["evidence", (v) => typeof v === "string" && v.trim().length >= 10, "Include at least one evidence URL and a short description"],
  ["requestedAmountUsdc", (v) => isValidWholeUsdcAmount(v as string), "Enter a whole USDC amount greater than 0"],
];

function SubmitClaimForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const channelId = searchParams.get("channelId") || "";
  const { address, connect } = useWallet();
  const [form, setForm] = useState<ClaimForm>({ evidence: "", requestedAmountUsdc: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const set = (key: keyof ClaimForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async () => {
    setError(null);
    const errors = validate(form, CHECKS);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !channelId) return;

    try {
      if (!address) await connect();
      setSubmitting(true);
      setStatus(formatWriteStatus("SUBMITTED"));
      const claimId = await submitClaim(
        { channelId, evidence: form.evidence, requestedAmountUsdc: Number(form.requestedAmountUsdc) },
        (statusName) => setStatus(formatWriteStatus(statusName))
      );
      router.push(`/claims/${claimId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit claim");
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto">
        <h1 className="font-semibold text-3xl text-text-primary mb-2">Submit Settlement Claim</h1>
        <p className="text-text-secondary text-sm mb-8">
          Against channel <span className="font-medium text-text-primary">{channelId || "(none selected)"}</span>
        </p>

        <Card className="space-y-6">
          <FormField label="Evidence" error={fieldErrors.evidence}>
            <Textarea
              rows={4}
              placeholder="https://example.com/tracking/12345 — the shipment tracking page for this delivery"
              value={form.evidence}
              onChange={set("evidence")}
            />
            <p className="mt-1.5 text-xs text-text-muted">
              Include the URL(s) Volt&rsquo;s validators should fetch and read as evidence. Only http(s) links are fetched.
            </p>
          </FormField>
          <FormField label="Requested amount (USDC)" error={fieldErrors.requestedAmountUsdc}>
            <Input type="number" min="1" placeholder="500" value={form.requestedAmountUsdc} onChange={set("requestedAmountUsdc")} />
          </FormField>
          {error && <p className="text-sm text-danger">{error}</p>}
          {submitting && status && <p className="text-sm text-text-secondary">{status}</p>}
          <Button className="w-full" onClick={handleSubmit} disabled={submitting || !channelId}>
            {submitting ? "Submitting…" : address ? "Submit Claim" : "Connect Wallet to Continue"}
          </Button>
        </Card>
      </div>
    </AppShell>
  );
}

export default function SubmitClaim() {
  return (
    <Suspense fallback={null}>
      <SubmitClaimForm />
    </Suspense>
  );
}
