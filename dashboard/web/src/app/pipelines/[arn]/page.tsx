import { PipelineExecutionPage } from '@/components/pages/PipelineExecutionPage';

export default async function Page({ params }: { params: Promise<{ arn: string }> }) {
  const { arn } = await params;
  return <PipelineExecutionPage arn={arn} />;
}
