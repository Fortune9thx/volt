import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { WalletProvider } from "@/lib/WalletContext";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Volt — Settlement that only moves when reality agrees",
  description:
    "Volt is a GenLayer-native settlement network where money only moves when multi-validator AI consensus confirms real-world conditions have been met.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-surface text-text-primary">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
