import type { Metadata, Viewport } from 'next';
import { Noto_Naskh_Arabic, Public_Sans, Source_Serif_4 } from 'next/font/google';
import './globals.css';

/**
 * Fonts are self-hosted by next/font at build time. On a slow connection that
 * removes a third-party round trip and a render-blocking stylesheet, and the
 * generated `size-adjust` fallback means no layout shift while the face loads.
 *
 * Urdu is set in Naskh rather than Nastaliq deliberately: Nastaliq is more
 * beautiful, and considerably harder to read at 16px on a low-DPI phone, which
 * is what this audience is actually holding.
 */
const latin = Public_Sans({
  subsets: ['latin'],
  variable: '--font-latin',
  display: 'swap',
});

/**
 * Headings are set in a serif, and that is a deliberate break from the sans
 * everything else uses. This is a document that tells someone what to do at a
 * government counter, and it should carry the weight of one — a uniform
 * geometric sans reads as a SaaS dashboard, which is the wrong promise to make
 * about a legal procedure. Restricted to display sizes, where a serif costs
 * nothing in legibility on a low-DPI screen.
 */
const display = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const urdu = Noto_Naskh_Arabic({
  subsets: ['arabic'],
  variable: '--font-urdu',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: {
    default: 'Government Service Navigator',
    template: '%s · Government Service Navigator',
  },
  description:
    'Turn complex Pakistani government procedures into personalised, source-verified action plans. Ask in English, Urdu or Roman Urdu.',
  applicationName: 'Government Service Navigator',
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available. Disabling it locks out anyone who needs to
  // magnify Urdu text, which is a real accessibility failure, not a polish item.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8faf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1413' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" className={`${latin.variable} ${display.variable} ${urdu.variable}`}>
      <body className="min-h-dvh">
        <a href="#main" className="sr-only-focusable btn-primary fixed left-4 top-4 z-50">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
