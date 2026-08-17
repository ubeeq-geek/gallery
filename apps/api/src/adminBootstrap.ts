import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient
} from '@aws-sdk/client-cognito-identity-provider';
import type { AppConfig } from './config';

export type AdminBootstrapResult =
  | { status: 'skipped'; reason: string }
  | { status: 'created'; username: string }
  | { status: 'existing'; username: string };

type CognitoClient = Pick<CognitoIdentityProviderClient, 'send'>;

const isNotFound = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'name' in error
  && (error as { name?: string }).name === 'UserNotFoundException'
);

const isAlreadyExists = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'name' in error
  && (error as { name?: string }).name === 'UsernameExistsException'
);

/**
 * Ensures the configured first administrator exists in Cognito.
 *
 * This is deliberately conservative: a missing user is created with a
 * permanent password and added to Admins; an existing user's password is
 * never changed. The operation is safe to run on every cold start.
 */
export const bootstrapAdminUser = async (
  config: Pick<AppConfig, 'cognitoUserPoolId' | 'awsRegion' | 'adminEmail' | 'adminPassword'>,
  client?: CognitoClient
): Promise<AdminBootstrapResult> => {
  const email = config.adminEmail?.trim().toLowerCase();
  const password = config.adminPassword;
  if (!config.cognitoUserPoolId) return { status: 'skipped', reason: 'Cognito user pool is not configured.' };
  if (!email) return { status: 'skipped', reason: 'ADMIN_EMAIL is empty.' };
  if (!password) return { status: 'skipped', reason: 'ADMIN_PASSWORD is not configured.' };

  const cognito = client || new CognitoIdentityProviderClient({ region: config.awsRegion });
  const userPoolId = config.cognitoUserPoolId;
  let exists = false;
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    exists = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (!exists) {
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' }
        ]
      }));
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: email,
        Password: password,
        Permanent: true
      }));
    } catch (error) {
      // Another cold start may win the create race. In that case, continue
      // with the idempotent group assignment without changing its password.
      if (!isAlreadyExists(error)) throw error;
      exists = true;
    }
  }

  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: email,
    GroupName: 'Admins'
  }));

  return { status: exists ? 'existing' : 'created', username: email };
};

export const runAdminBootstrap = async (config: AppConfig): Promise<void> => {
  try {
    const result = await bootstrapAdminUser(config);
    if (result.status === 'skipped') {
      console.info(`[admin-bootstrap] skipped: ${result.reason}`);
    } else {
      console.info(`[admin-bootstrap] ${result.status}: ${result.username}`);
    }
  } catch (error) {
    // A bad bootstrap configuration must be visible without taking down the
    // content API. No password or secret is included in this message.
    console.error(`[admin-bootstrap] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
