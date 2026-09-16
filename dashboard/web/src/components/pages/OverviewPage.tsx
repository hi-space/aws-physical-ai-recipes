'use client';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, Spinner } from '@/components/ui';
import { useApi } from '@/lib/api-client';

export function OverviewPage() {
  const { data, isLoading } = useApi<Record<string, unknown>>('/api/overview', { refetch: 15000 });
  return (
    <>
      <PageHeader title="Overview" description="Placeholder — replaced in Task 11." />
      <Card>{isLoading ? <Spinner /> : <pre className="mono text-xs">{JSON.stringify(data, null, 2).slice(0, 4000)}</pre>}</Card>
    </>
  );
}
