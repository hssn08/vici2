import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "vici2",
  description: "Open-source Vicidial alternative",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          margin: 0,
          padding: 0,
          background: "#0b0d10",
          color: "#e6e6e6",
        }}
      >
        {children}
      </body>
    </html>
  );
}
