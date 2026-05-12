import type { ReactNode } from "react";

export const metadata = {
  title: "CrossEngin",
  description: "AI-native application platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
