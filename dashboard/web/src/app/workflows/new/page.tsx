import { Suspense } from 'react';
import { NewWorkflowPage } from '@/components/pages/NewWorkflowPage';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NewWorkflowPage  />
    </Suspense>
  );
}
