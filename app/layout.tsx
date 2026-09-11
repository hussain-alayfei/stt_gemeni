import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Gemini Speech to Text",
  description: "Fast Arabic and English speech-to-text powered by Gemini.",
};

const themeScript = `
(() => {
  try {
    const saved = localStorage.getItem("stt-theme") || "system";
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = saved === "system" ? (dark ? "dark" : "light") : saved;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {}
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={plex.variable}>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
