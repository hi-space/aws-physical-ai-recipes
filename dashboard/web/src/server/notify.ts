import { PublishCommand } from '@aws-sdk/client-sns';
import { sns } from './aws/clients';
import { config } from './config';

/** Publish to the dashboard SNS topic when one is configured. */
export async function notify(subject: string, message: string): Promise<void> {
  const topic = config().snsTopicArn;
  if (!topic) return;
  try {
    await sns().send(new PublishCommand({ TopicArn: topic, Subject: subject.slice(0, 99), Message: message }));
  } catch (e) {
    console.error('SNS publish failed', e);
  }
}
