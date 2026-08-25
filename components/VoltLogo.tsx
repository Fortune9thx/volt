export function VoltLogo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"
            fill="white"
          />
        </svg>
      </span>
      <span
        className={
          dark
            ? "text-lg font-semibold tracking-tight text-text-on-dark"
            : "text-lg font-semibold tracking-tight text-text-primary"
        }
      >
        Volt
      </span>
    </span>
  );
}
