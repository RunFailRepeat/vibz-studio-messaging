import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vibz Studio — Team + Agents",
  description: "A shared workspace for the Vibz Studio team and their agents. Conversations, tasks, visible progress, and human review.",
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
      <body className="antialiased">{children}</body>
    </html>
  );
}
