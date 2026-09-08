import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gemini Speech to Text",
  description: "Fast Arabic and English speech-to-text powered by Gemini.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
