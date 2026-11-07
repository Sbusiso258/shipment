import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Shipment references, waybill numbers and timestamps are codes. A mono face
// with tabular figures keeps a column of them from jittering as digits change.
const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono-code",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Shipment Oversight",
    template: "%s · Shipment Oversight",
  },
  description:
    "See a shipment's whole journey — origin to destination, every checkpoint in between, and whatever is running late.",
};

export const viewport: Viewport = {
  // A single value, not a prefers-color-scheme array: the app's own default is
  // dark regardless of the OS setting, and a media-based value would disagree
  // with it on a light-OS machine. This only tints browser chrome, and it
  // cannot follow the in-app toggle.
  themeColor: "#060d1f",
};

/**
 * Applied before paint, so the theme is never wrong for a frame.
 *
 * Dark is the default and lives in `:root`, so this script only ever ADDS
 * `.light`. That polarity matters: with no script, no JavaScript, or a
 * throwing `localStorage`, the page still renders as dark rather than
 * flashing white.
 *
 * A stored preference wins outright; without one the answer is dark, NOT the
 * OS setting — the product's default was chosen deliberately. Changing that
 * to follow `prefers-color-scheme` is one line, if it is ever wanted.
 */
const themeScript = `
(function () {
  try {
    var d = document.documentElement;
    if (localStorage.getItem("shipment-oversight:theme:v1") === "light") {
      d.classList.add("light");
    }
    var density = localStorage.getItem("shipment-oversight:density:v1");
    if (density === "small" || density === "large") {
      d.setAttribute("data-density", density);
    }
    if (localStorage.getItem("shipment-oversight:header:v1") === "hidden") {
      d.setAttribute("data-header", "hidden");
    }
    // The rail is the DEFAULT, so the attribute marks the expanded state —
    // the same convention as density, where medium is no attribute at all.
    if (localStorage.getItem("shipment-oversight:nav:v1") === "full") {
      d.setAttribute("data-nav", "full");
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetBrainsMono.variable} h-full antialiased`}
      // React owns this element's attributes in the App Router, and the script
      // above adds a class before hydration. Without this, every page logs a
      // hydration mismatch for a difference we created on purpose.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
