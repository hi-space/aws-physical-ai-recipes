import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MLOps Dashboard - IsaacLab Fleet Monitor',
  description: 'Monitor IsaacLab RL training instances on AWS EC2 Batch',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
