import clsx from "clsx";

const STYLES: Record<string, string> = {
  active: "bg-teal-500/10 text-teal-600",
  closing: "bg-orange-500/10 text-orange-500",
  closed: "bg-surface-sunken text-text-muted",
  pending: "bg-blue-500/10 text-blue-600",
  judged: "bg-orange-500/10 text-orange-500",
  executed: "bg-teal-500/10 text-teal-600",
  rejected: "bg-danger/10 text-danger",
  full: "bg-teal-500/10 text-teal-600",
  partial: "bg-orange-500/10 text-orange-500",
  refund: "bg-surface-sunken text-text-muted",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium capitalize",
        STYLES[status] || "bg-surface-sunken text-text-muted"
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
