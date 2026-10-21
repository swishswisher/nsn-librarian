import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
const inter = localFont({ src: [
  { path: "../../public/fonts/inter-latin-wght-normal.woff2", weight: "100 900", style: "normal" },
  { path: "../../public/fonts/inter-latin-wght-italic.woff2", weight: "100 900", style: "italic" },
], variable: "--font-inter", display: "swap" });
const lora = localFont({ src: [
  { path: "../../public/fonts/lora-latin-wght-normal.woff2", weight: "400 700", style: "normal" },
  { path: "../../public/fonts/lora-latin-wght-italic.woff2", weight: "400 700", style: "italic" },
], variable: "--font-lora", display: "swap" });

export const metadata: Metadata = {
  title: "NSN Library Machine",
  description:
    "Internal intake, classification, review, and migration console for the NSN library.",
  other: {
    "color-scheme": "light only",
    "darkreader-lock": "true",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${lora.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
