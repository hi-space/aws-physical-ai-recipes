import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/layout/Providers';
import { Sidebar } from '@/components/layout/Sidebar';
import { resolveRequestLocale } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Physical AI Dashboard', description: 'Workflows, datasets, compute and observability for Physical AI on AWS' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveRequestLocale();
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <Providers locale={locale}>
          <div className="flex">
            <Sidebar />
            <main className="min-h-screen min-w-0 flex-1 px-8 py-6">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
