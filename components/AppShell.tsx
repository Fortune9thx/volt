import { ReactNode } from "react";
import { Navbar } from "./Navbar";
import { WalletButton } from "./WalletButton";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-surface-alt">
      <Navbar rightSlot={<WalletButton />} />
      <main className="flex-1 mx-auto w-full max-w-7xl px-6 py-10">{children}</main>
    </div>
  );
}
