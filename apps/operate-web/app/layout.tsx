import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";
import { ShellBar } from "@/components/ShellBar";
import { Sidebar } from "@/components/Sidebar";
import { SubscriptionBanner } from "@/components/SubscriptionBanner";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CrossEngin Operate",
  description: "Enterprise ERP console on CrossEngin",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans">
        <div className="flex min-h-screen flex-col">
          <ShellBar />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="h-[calc(100vh-3.5rem)] flex-1 overflow-y-auto">
              <SubscriptionBanner />
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
