"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { FormField, Input, Textarea } from "@/components/FormField";
import { Button } from "@/components/Button";
import { useWallet } from "@/lib/WalletContext";
import { createChannel } from "@/lib/genlayer";
import { validate } from "@/lib/validation";

interface ChannelForm {
  mandate: string;
  parties: string;
  expiry: string;
}

const CHECKS: Array<[keyof ChannelForm, (v: unknown, all: ChannelForm) => boolean, string]> = [
  ["mandate", (v) => typeof v === "string" && v.trim().length >= 20, "Describe the settlement condition in at least 20 characters"],
  ["parties", (v) => typeof v === "string" && v.trim().length >= 10, "Enter at least one party address"],
  ["expiry", (v) => typeof v === "string" && v.trim().length >= 2, "Expiry date is required"],
];

export default function CreateChannel() {
  const router = useRouter();
  const { address, connect } = useWallet();
  const [form, setForm] = useState<ChannelForm>({ mandate: "", parties: "", expiry: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof ChannelForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async () => {
    setError(null);
    const errors = validate(form, CHECKS);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      let addr = address;
      if (!addr) addr = await connect();
      setSubmitting(true);
      const parties = form.parties.includes(addr) ? form.parties : `${addr},${form.parties}`;
      const channelId = await createChannel({ mandate: form.mandate, parties, expiry: form.expiry });
      router.push(`/channels/${channelId}?justCreated=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto">
        <h1 className="font-semibold text-3xl text-text-primary mb-2">New Settlement Channel</h1>
        <p className="text-text-secondary text-sm mb-8">
          Describe the real-world condition that should trigger settlement, in plain English.
        </p>

        <Card className="space-y-6">
          <FormField label="Settlement Mandate" error={fieldErrors.mandate}>
            <Textarea
              rows={5}
              placeholder='e.g. "Release funds to the claimant if the linked shipment tracking page shows status DELIVERED at the destination address."'
              value={form.mandate}
              onChange={set("mandate")}
            />
          </FormField>
          <FormField label="Parties (comma-separated addresses)" error={fieldErrors.parties}>
            <Input placeholder="0xabc..., 0xdef..." value={form.parties} onChange={set("parties")} />
            <p className="mt-1.5 text-xs text-text-muted">Your own address is added automatically as the channel&rsquo;s funder.</p>
          </FormField>
          <FormField label="Expiry" error={fieldErrors.expiry}>
            <Input type="date" value={form.expiry} onChange={set("expiry")} />
          </FormField>
          <p className="text-xs text-text-muted leading-relaxed rounded-lg bg-surface-alt p-3">
            Creating a channel doesn&rsquo;t lock funds yet. After creation, you&rsquo;ll lock real USDC on Base
            Sepolia against this channel&rsquo;s id — Volt&rsquo;s relayer mirrors that lock here once it&rsquo;s confirmed.
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button className="w-full" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Creating…" : address ? "Create Channel" : "Connect Wallet to Continue"}
          </Button>
        </Card>
      </div>
    </AppShell>
  );
}
