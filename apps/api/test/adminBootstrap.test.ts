import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { bootstrapAdminUser } from '../src/adminBootstrap';

const config = {
  cognitoUserPoolId: 'pool-id',
  awsRegion: 'ca-central-1' as const,
  adminEmail: 'Admin@Eversally.com',
  adminPassword: 'not-a-real-password'
};

describe('first administrator bootstrap', () => {
  it('creates a missing user, sets its password once, and adds Admins', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'UserNotFoundException' }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await bootstrapAdminUser(config, { send });

    expect(result).toEqual({ status: 'created', username: 'admin@eversally.com' });
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      AdminGetUserCommand,
      AdminCreateUserCommand,
      AdminSetUserPasswordCommand,
      AdminAddUserToGroupCommand
    ]);
    expect(send.mock.calls[1][0].input).toMatchObject({
      Username: 'admin@eversally.com',
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: 'admin@eversally.com' },
        { Name: 'email_verified', Value: 'true' }
      ]
    });
    expect(send.mock.calls[2][0].input).toMatchObject({
      Password: 'not-a-real-password',
      Permanent: true
    });
  });

  it('does not reset an existing user password', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ Username: 'admin@eversally.com' })
      .mockResolvedValueOnce({});

    const result = await bootstrapAdminUser(config, { send });

    expect(result).toEqual({ status: 'existing', username: 'admin@eversally.com' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(AdminAddUserToGroupCommand);
  });

  it('skips safely when a password is not configured', async () => {
    const send = jest.fn();
    const result = await bootstrapAdminUser({ ...config, adminPassword: '' }, { send });
    expect(result).toEqual({ status: 'skipped', reason: 'ADMIN_PASSWORD is not configured.' });
    expect(send).not.toHaveBeenCalled();
  });
});
