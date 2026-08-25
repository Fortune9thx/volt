import Link from "next/link";
import { VoltLogo } from "./VoltLogo";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/channels/new", label: "Create Channel" },
  { href: "/settlements", label: "Settlements" },
  { href: "/docs", label: "Docs" },
];

interface NavbarProps {
  dark?: boolean;
  rightSlot?: React.ReactNode;
}

export function Navbar({ dark = false, rightSlot }: NavbarProps) {
  return (
    <header
      className={
        dark
          ? "sticky top-0 z-40 bg-charcoal-950/95 backdrop-blur border-b border-white/5"
          : "sticky top-0 z-40 bg-surface/95 backdrop-blur border-b border-border-subtle"
      }
    >
      <nav className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <VoltLogo dark={dark} />
        </Link>
        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                dark
                  ? "text-sm text-text-on-dark-muted hover:text-text-on-dark transition-colors"
                  : "text-sm text-text-secondary hover:text-text-primary transition-colors"
              }
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div>{rightSlot}</div>
      </nav>
    </header>
  );
}
