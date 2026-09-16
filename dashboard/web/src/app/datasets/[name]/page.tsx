import { DatasetDetailPage } from '@/components/pages/DatasetDetailPage';

interface Params {
  name: string;
}

export default async function Page({ params }: { params: Promise<Params> }) {
  const { name } = await params;
  return <DatasetDetailPage name={name} />;
}
