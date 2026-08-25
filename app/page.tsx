import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { HeroIllustration } from "@/components/HeroIllustration";

const FEATURES = [
  {
    title: "Natural-language Mandates",
    body: "Describe the real-world condition in plain English. No fixed schema, no rigid oracle feed to shoehorn reality into.",
    accentClass: "bg-teal-500",
  },
  {
    title: "Two-stage AI consensus",
    body: "Independent validators fetch live evidence and judge intent separately before any fund ever moves. Fail-closed by design.",
    accentClass: "bg-orange-500",
  },
  {
    title: "Continuous channels",
    body: "Lock funds once, settle many times. A channel stays open under its Mandate for as long as the parties need it.",
    accentClass: "bg-blue-500",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col">
      <div className="relative bg-charcoal-950 hero-diagonal pb-32">
        <Navbar dark rightSlot={<Link href="/dashboard"><Button size="md">Launch App</Button></Link>} />
        <div className="mx-auto max-w-7xl px-6 pt-20 pb-24 grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <p className="text-sm font-medium text-teal-400 mb-4 tracking-wide uppercase">
              GenLayer-native settlement
            </p>
            <h1 className="text-5xl md:text-6xl font-semibold tracking-tight text-text-on-dark mb-6 leading-[1.05]">
              Settlement that only moves when reality agrees.
            </h1>
            <p className="text-lg text-text-on-dark-muted mb-10 max-w-xl leading-relaxed">
              Classical oracles can price an asset. They cannot read a shipment
              tracking page, a court filing, or a natural-language agreement.
              Volt&rsquo;s multi-validator AI consensus can — and only settles
              funds when it genuinely does.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link href="/channels/new">
                <Button size="lg">Create a Channel</Button>
              </Link>
              <Link href="/docs">
                <Button size="lg" variant="ghost" className="border-white/15 text-text-on-dark hover:bg-white/5">
                  Read the docs
                </Button>
              </Link>
            </div>
          </div>
          <HeroIllustration />
        </div>
      </div>

      <section className="mx-auto max-w-7xl px-6 -mt-16 pb-24">
        <div className="grid md:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <span className={`inline-block h-2 w-2 rounded-full ${f.accentClass} mb-4`} />
              <h3 className="text-lg font-semibold text-text-primary mb-2">{f.title}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{f.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-surface-alt py-24">
        <div className="mx-auto max-w-7xl px-6 grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <p className="text-teal-600 font-semibold mb-3">How it works</p>
            <h2 className="text-3xl font-semibold text-text-primary mb-4">
              A settlement channel, not a one-shot bet.
            </h2>
            <p className="text-text-secondary leading-relaxed mb-6 max-w-md">
              Lock funds against a Mandate once. Submit claims with evidence
              as real-world events happen. Every claim is judged independently
              — the channel stays open for the next one.
            </p>
            <Link href="/dashboard" className="text-blue-500 font-medium hover:underline">
              Explore the dashboard →
            </Link>
          </div>
          <ol className="space-y-4">
            {[
              "Create a Channel with a natural-language Mandate and lock funds",
              "Submit a Settlement Claim with evidence pointers",
              "Volt fetches live evidence and runs two-stage AI judgment",
              "On consensus, execute settlement — full, partial, or refund",
            ].map((step, i) => (
              <li key={step} className="flex gap-4 items-start bg-surface rounded-xl shadow-card p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-500 text-white text-sm font-semibold">
                  {i + 1}
                </span>
                <span className="text-sm text-text-primary pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="py-10 text-center text-sm text-text-muted">
        Built on{" "}
        <a href="https://genlayer.com" className="text-teal-600 hover:underline">
          GenLayer
        </a>
      </footer>
    </div>
  );
}
