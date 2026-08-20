import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: "Eagle Shield Calendar",
  description:
    "NorCal appointment scheduling for Eagle Shield's East Bay and Sacramento teams.",
  openGraph: {
    title: "Eagle Shield Calendar",
    description: "Reliable appointment operations for Sacramento and East Bay.",
    images: [{ url: "/og.png", width: 1536, height: 1024 }],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
