import { Suspense } from 'react';
import { ComposePage } from '@/components/compose/ComposePage';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ComposePage />
    </Suspense>
  );
}
