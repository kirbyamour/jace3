import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "Jace", description: "A lifelong conversation." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>{children}</body></html>
  );
}
