export function HeroIllustration() {
  return (
    <div className="relative w-full max-w-md mx-auto lg:mx-0">
      <div
        className="absolute -top-10 -left-10 h-64 w-64 rounded-full opacity-30 blur-2xl"
        style={{ background: "radial-gradient(circle, rgba(20,184,166,0.5) 0%, transparent 70%)" }}
      />
      <div
        className="relative rounded-2xl bg-white shadow-card-hover p-5"
        style={{ transform: "rotate(-6deg)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
            Settlement Mandate
          </span>
          <span className="flex items-center gap-1 rounded-full bg-teal-500/10 px-2.5 py-1 text-[11px] font-medium text-teal-600">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
            Consensus reached
          </span>
        </div>
        <p className="text-sm text-text-primary leading-relaxed mb-5">
          &ldquo;Release 5,000 USDC when the shipment tracking page confirms
          delivery at the destination address.&rdquo;
        </p>
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-teal-500 shrink-0" />
            <div className="h-2.5 flex-1 rounded-full bg-surface-sunken" />
            <span className="text-[11px] font-medium text-teal-600">Full</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-orange-500 shrink-0" />
            <div className="h-2.5 w-2/3 rounded-full bg-surface-sunken" />
            <span className="text-[11px] font-medium text-orange-500">Partial</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-border-subtle shrink-0" />
            <div className="h-2.5 w-1/2 rounded-full bg-surface-sunken" />
            <span className="text-[11px] font-medium text-text-muted">Refund</span>
          </div>
        </div>
      </div>
      <div
        className="absolute -bottom-8 -right-6 w-40 rounded-xl bg-charcoal-900 shadow-card p-4"
        style={{ transform: "rotate(4deg)" }}
      >
        <p className="text-[10px] uppercase tracking-wide text-text-on-dark-muted mb-2">
          Validators
        </p>
        <div className="flex gap-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="h-6 w-6 rounded-full bg-teal-500 flex items-center justify-center text-[10px] text-white font-semibold"
            >
              ✓
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
