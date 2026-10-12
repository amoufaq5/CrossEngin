import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";
import { AppChrome } from "@/components/AppChrome";

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
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
