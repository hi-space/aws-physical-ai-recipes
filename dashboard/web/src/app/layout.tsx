import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Providers } from '@/components/layout/Providers';
import { Sidebar } from '@/components/layout/Sidebar';
import { resolveRequestLocale } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Physical AI Dashboard', description: 'Workflows, datasets, compute and observability for Physical AI on AWS' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveRequestLocale();
  // The middleware sets this only on /login (see proxy.ts): render without the
  // sidebar so the auth-less login page has no chrome that would 401-loop.
  const bare = (await headers()).get('x-pai-bare-layout') === '1';
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <Providers locale={locale}>
          {bare ? (
            <main className="min-h-screen min-w-0 flex-1">{children}</main>
          ) : (
            <div className="flex">
              <Sidebar />
              <main className="min-h-screen min-w-0 flex-1 px-8 py-6">{children}</main>
            </div>
          )}
        </Providers>
      </body>
    </html>
  );
}
