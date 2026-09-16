import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/layout/Providers';
import { Sidebar } from '@/components/layout/Sidebar';

export const metadata: Metadata = { title: 'Physical AI Dashboard', description: 'Workflows, datasets, compute and observability for Physical AI on AWS' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen">
        <Providers>
          <div className="flex">
            <Sidebar />
            <main className="min-h-screen min-w-0 flex-1 px-6 py-5">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
