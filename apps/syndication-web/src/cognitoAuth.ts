import {
  CognitoIdentityProviderClient,
  GlobalSignOutCommand,
  InitiateAuthCommand
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = import.meta.env.VITE_COGNITO_REGION || 'ca-central-1';
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || '';

const ID_TOKEN_KEY = 'syn_idToken';
const ACCESS_TOKEN_KEY = 'syn_accessToken';
const REFRESH_TOKEN_KEY = 'syn_refreshToken';
const USERNAME_KEY = 'syn_username';

const client = new CognitoIdentityProviderClient({ region: REGION });

const parseJwtPayload = (jwt: string): Record<string, unknown> => {
  const payload = jwt.split('.')[1];
  if (!payload) return {};
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
};

export const getCurrentUser = () => {
  const idToken = localStorage.getItem(ID_TOKEN_KEY);
  const username = localStorage.getItem(USERNAME_KEY);
  if (!idToken || !username) return null;
  const payload = parseJwtPayload(idToken);
  return {
    username,
    groups: Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : []
  };
};

export const getIdToken = () => localStorage.getItem(ID_TOKEN_KEY);

export const signIn = async (username: string, password: string) => {
  if (!CLIENT_ID) throw new Error('Missing VITE_COGNITO_CLIENT_ID');
  const response = await client.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: username, PASSWORD: password }
  }));
  if (!response.AuthenticationResult?.IdToken || !response.AuthenticationResult.AccessToken) {
    throw new Error('Sign-in failed');
  }
  localStorage.setItem(ID_TOKEN_KEY, response.AuthenticationResult.IdToken);
  localStorage.setItem(ACCESS_TOKEN_KEY, response.AuthenticationResult.AccessToken);
  if (response.AuthenticationResult.RefreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, response.AuthenticationResult.RefreshToken);
  }
  localStorage.setItem(USERNAME_KEY, username);
};

export const signOut = async () => {
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (accessToken) {
    try {
      await client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
    } catch {
      // noop
    }
  }
  localStorage.removeItem(ID_TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
};
