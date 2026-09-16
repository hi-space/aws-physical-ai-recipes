import { expect, it } from 'vitest';
import { expression, matches } from './atomic';
it('expresses optional-field absence without undefined DynamoDB expression values', () => {
  const condition = { equals: { namespace: 'team', backendId: undefined } };
  expect(matches({ pk: 'p', sk: 'META', namespace: 'team' }, condition)).toBe(true);
  expect(matches({ pk: 'p', sk: 'META', namespace: 'team', backendId: 'other' }, condition)).toBe(false);
  expect(expression(condition)).toEqual({
    ConditionExpression: '#c0 = :c0 AND attribute_not_exists(#c1)',
    ExpressionAttributeNames: { '#c0': 'namespace', '#c1': 'backendId' },
    ExpressionAttributeValues: { ':c0': 'team' },
  });
  expect(expression({ equals: { backendId: undefined } })).not.toHaveProperty('ExpressionAttributeValues');
  expect(expression({ equals: {} })).toEqual({ ConditionExpression: 'attribute_exists(pk)' });
});
