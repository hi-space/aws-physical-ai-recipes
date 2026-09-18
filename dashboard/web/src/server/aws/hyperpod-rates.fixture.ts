/**
 * Test-only fixture for synthetic HyperPod pricing snapshots.
 * Provides a minimal offer-file JSON and helpers for unit/browser tests.
 */
import { parseHyperpodRates, type RateSnapshot } from './hyperpod-rates';

/** Minimal synthetic offer file: CPU-only and GPU instance types. */
export function syntheticOfferFile(region: string = 'us-east-1') {
  const date = '2026-09-16T00:00:00Z';
  return {
    offerCode: 'AmazonSageMaker',
    version: '20260916',
    publicationDate: date,
    products: {
      cpu: {
        attributes: {
          instanceType: 'ml.c5.4xlarge-Cluster',
          usagetype: 'USE1-Cluster:ml.c5.4xlarge',
          component: 'Cluster',
          regionCode: region,
          vCpu: '16',
          gpu: 'N/A',
        },
      },
      gpu: {
        attributes: {
          instanceType: 'ml.g5.8xlarge-Cluster',
          usagetype: 'USE1-Cluster:ml.g5.8xlarge',
          component: 'Cluster',
          regionCode: region,
          vCpu: '32',
          gpu: '1',
        },
      },
    },
    terms: {
      OnDemand: {
        cpu: {
          term: {
            effectiveDate: date,
            priceDimensions: {
              d: {
                rateCode: 'cpu-rate',
                unit: 'Hrs',
                beginRange: '0',
                endRange: 'Inf',
                pricePerUnit: { USD: '0.816' },
              },
            },
          },
        },
        gpu: {
          term: {
            effectiveDate: date,
            priceDimensions: {
              d: {
                rateCode: 'gpu-rate',
                unit: 'Hrs',
                beginRange: '0',
                endRange: 'Inf',
                pricePerUnit: { USD: '3.06' },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Parse a synthetic snapshot for a given region. Used in both unit tests and browser tests.
 */
export function createTestSnapshot(region: string = 'us-east-1', now = new Date('2026-09-16T18:00:00Z')): RateSnapshot {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/${region}/index.json`;
  return parseHyperpodRates(JSON.stringify(syntheticOfferFile(region)), url, now, region);
}
