import { NextResponse } from 'next/server';
import { mockExperiments, mockTrainingMetrics } from '@/data/mockWorkers';

export async function GET() {
  // Experiments and training metrics are currently mock-only.
  // In production, these would come from a metadata store (DynamoDB, S3, etc.)
  return NextResponse.json({
    experiments: mockExperiments,
    trainingMetrics: mockTrainingMetrics,
    source: 'mock',
  });
}
