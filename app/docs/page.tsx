import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";

const SECTIONS = [
  {
    title: "1. Create a Channel",
    body: "Describe your Settlement Mandate in plain English — the real-world condition that should release funds — and specify the parties involved and an expiry date.",
  },
  {
    title: "2. Lock funds on Base",
    body: "Real USDC is locked on Base Sepolia's VoltEscrow contract, not on GenLayer. Volt's relayer observes the lock and mirrors it into GenLayer's ledger within moments.",
  },
  {
    title: "3. Submit a Claim",
    body: "Any party may submit a Settlement Claim with evidence URLs. Volt's contract fetches those URLs itself — in contract code, not as a free-text assertion — before any judgment runs.",
  },
  {
    title: "4. Two-stage judgment",
    body: "Stage A independently verifies the fetched evidence (fail-closed if nothing checkable was found). Stage B judges the Mandate's intent against those already-agreed facts, deciding a full, partial, or refund outcome.",
  },
  {
    title: "5. Execute & relay",
    body: "Once judged, execute_settlement finalizes GenLayer's own ledger. The relayer then executes the real USDC transfer on Base and reports back — a channel stays open for further claims under the same Mandate.",
  },
];

export default function Docs() {
  return (
    <AppShell>
      <div className="max-w-3xl mx-auto">
        <h1 className="font-semibold text-3xl text-text-primary mb-2">How Volt works</h1>
        <p className="text-text-secondary text-sm mb-10">
          A settlement channel, not a one-shot bet — read the full trust model and architecture in this
          repository&rsquo;s SECURITY.md and README.
        </p>
        <div className="space-y-5">
          {SECTIONS.map((s) => (
            <Card key={s.title} hover={false}>
              <h2 className="text-sm font-semibold text-text-primary mb-2">{s.title}</h2>
              <p className="text-sm text-text-secondary leading-relaxed">{s.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
