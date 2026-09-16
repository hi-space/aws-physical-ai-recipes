import { DescribeLogStreamsCommand, FilterLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../config';
import { cwlogs } from './clients';

export interface LogLine { ts: number; message: string }

/** Resolve the HyperPod EKS container log group (one per cluster id). */
export async function eksContainerLogGroup(): Promise<string | undefined> {
  const prefix = config().eks?.logGroupPrefix;
  if (!prefix) return undefined;
  const { DescribeLogGroupsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
  const out = await cwlogs().send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix + '/' }));
  const groups = (out.logGroups ?? []).sort((a, b) => (b.creationTime ?? 0) - (a.creationTime ?? 0));
  return groups[0]?.logGroupName;
}

/**
 * Historical pod logs shipped by the observability add-on's Fluent Bit:
 * stream name `FluentBit/kube.var.log.containers.<pod>_<ns>_<container>-<id>.log`.
 */
export async function podLogsFromCloudWatch(namespace: string, pod: string, limit = 2000): Promise<LogLine[]> {
  const group = await eksContainerLogGroup();
  if (!group) return [];
  const streams = await cwlogs().send(
    new DescribeLogStreamsCommand({ logGroupName: group, logStreamNamePrefix: `FluentBit/kube.var.log.containers.${pod}_${namespace}_`, limit: 5 }),
  );
  const names = (streams.logStreams ?? []).map((s) => s.logStreamName!).filter(Boolean);
  if (!names.length) return [];
  const out = await cwlogs().send(new FilterLogEventsCommand({ logGroupName: group, logStreamNames: names, limit }));
  return (out.events ?? []).map((e) => ({ ts: e.timestamp ?? 0, message: extractLog(e.message ?? '') }));
}

function extractLog(raw: string): string {
  try {
    const j = JSON.parse(raw) as { log?: string; message?: string };
    return (j.log ?? j.message ?? raw).replace(/\n$/, '');
  } catch {
    return raw;
  }
}

export async function tailStream(group: string, streamPrefix: string, limit = 500): Promise<LogLine[]> {
  const streams = await cwlogs().send(new DescribeLogStreamsCommand({ logGroupName: group, logStreamNamePrefix: streamPrefix, orderBy: 'LogStreamName', limit: 10 }));
  const names = (streams.logStreams ?? []).map((s) => s.logStreamName!);
  if (!names.length) return [];
  if (names.length === 1) {
    const out = await cwlogs().send(new GetLogEventsCommand({ logGroupName: group, logStreamName: names[0], limit, startFromHead: false }));
    return (out.events ?? []).map((e) => ({ ts: e.timestamp ?? 0, message: e.message ?? '' }));
  }
  const out = await cwlogs().send(new FilterLogEventsCommand({ logGroupName: group, logStreamNames: names.slice(0, 100), limit }));
  return (out.events ?? []).map((e) => ({ ts: e.timestamp ?? 0, message: e.message ?? '' }));
}
