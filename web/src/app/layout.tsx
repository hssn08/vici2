import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "vici2", template: "%s · vici2" },
  description: "Open-source Vicidial alternative on FreeSWITCH + MySQL + BYOC",
};

export const viewport: Viewport = {
  themeColor: "#0b0d10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
