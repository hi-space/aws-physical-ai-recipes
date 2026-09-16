import { beforeEach, expect, it, vi } from 'vitest';
import { currentUserAuthorization } from '../aws/cognito';
const send = vi.hoisted(() => vi.fn());
vi.mock('../aws/clients', () => ({ cognito: () => ({ send }) }));
vi.mock('../config', () => ({ config: () => ({ cognitoUserPoolId: 'pool' }) }));
beforeEach(() => send.mockReset());
it('loads fresh identity and all group pages for the canonical Cognito username', async () => {
  send.mockResolvedValueOnce({ Username: 'canonical', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 'sub' }, { Name: 'email', Value: 'user@example.test' }] })
    .mockResolvedValueOnce({ Groups: [{ GroupName: 'unrelated' }], NextToken: 'page2' })
    .mockResolvedValueOnce({ Groups: [{ GroupName: 'researchers' }] });
  expect(await currentUserAuthorization('alias')).toEqual({ username: 'canonical', subject: 'sub', email: 'user@example.test', enabled: true, groups: ['unrelated', 'researchers'] });
  expect(send.mock.calls[0][0].constructor.name).toBe('AdminGetUserCommand');
  expect(send.mock.calls[2][0].input).toMatchObject({ UserPoolId: 'pool', Username: 'canonical', NextToken: 'page2' });
  send.mockResolvedValueOnce({ Username: 'canonical', Enabled: false, UserAttributes: [{ Name: 'sub', Value: 'sub' }] }).mockResolvedValueOnce({ Groups: [] });
  expect((await currentUserAuthorization('canonical')).enabled).toBe(false);
});
it('rejects broken group pagination rather than accepting an incomplete role', async () => {
  send.mockResolvedValueOnce({ Username: 'user', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 'sub' }] })
    .mockResolvedValue({ Groups: [], NextToken: 'repeat' });
  await expect(currentUserAuthorization('user')).rejects.toThrow('pagination');
});
