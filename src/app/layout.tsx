import type { Metadata } from 'next';
import { LEGAL_NOTICE, SOURCE } from '@/lib/config';
import { AppStateProvider } from '@/components/app-state';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'TownPlanMap KML Extractor',
  description: 'Extract publicly accessible geographic map data and export it as KML.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AppStateProvider>
          <div className="flex min-h-screen flex-col">
            <Nav />
            <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6">{children}</main>
            <footer className="border-t border-[var(--color-border)] px-4 py-5 sm:px-6">
              <div className="mx-auto max-w-[1600px] space-y-2">
                <p className="max-w-4xl text-xs leading-relaxed text-[var(--color-ink-subtle)]">{LEGAL_NOTICE}</p>
                <p className="text-xs text-[var(--color-ink-subtle)]">
                  {SOURCE.name} describes its service as an informational and decision-support platform and recommends
                  verifying information with the relevant government authority for legal or official purposes. This tool
                  is an independent extractor and is not affiliated with {SOURCE.name}.
                </p>
              </div>
            </footer>
          </div>
        </AppStateProvider>
      </body>
    </html>
  );
}
