import {
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand
} from '@aws-sdk/client-cognito-identity-provider';

const COGNITO_REGION = import.meta.env.VITE_COGNITO_REGION || 'ca-central-1';
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || '';

const ID_TOKEN_KEY = 'idToken';
const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const USERNAME_KEY = 'username';
const AUTH_PERSISTENCE_KEY = 'authPersistence';

const client = new CognitoIdentityProviderClient({ region: COGNITO_REGION });

const requireClientId = () => {
  if (!COGNITO_CLIENT_ID) {
    throw new Error('Missing VITE_COGNITO_CLIENT_ID');
  }
};

const parseJwtPayload = (jwt: string): Record<string, unknown> => {
  const payload = jwt.split('.')[1];
  if (!payload) return {};
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
};

const getTokenExpiryMs = (jwt: string): number => {
  const payload = parseJwtPayload(jwt);
  const exp = Number(payload.exp || 0);
  return exp > 0 ? exp * 1000 : 0;
};

const getAuthStorage = () => {
  const preference = localStorage.getItem(AUTH_PERSISTENCE_KEY);
  return preference === 'session' ? sessionStorage : localStorage;
};

const getStoredValue = (key: string): string | null => {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
};

const clearTokenStorage = () => {
  localStorage.removeItem(ID_TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
  sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  sessionStorage.removeItem(USERNAME_KEY);
};

const persistTokens = (username: string, authResult: { IdToken?: string; AccessToken?: string; RefreshToken?: string }) => {
  if (!authResult.IdToken || !authResult.AccessToken) {
    throw new Error('Authentication tokens missing');
  }
  clearTokenStorage();
  const storage = getAuthStorage();
  storage.setItem(ID_TOKEN_KEY, authResult.IdToken);
  storage.setItem(ACCESS_TOKEN_KEY, authResult.AccessToken);
  if (authResult.RefreshToken) storage.setItem(REFRESH_TOKEN_KEY, authResult.RefreshToken);
  storage.setItem(USERNAME_KEY, username);
};

export type CurrentUser = {
  username: string;
  email?: string;
  displayName?: string;
  groups: string[];
} | null;

export type SignInResult =
  | { status: 'authenticated'; user: CurrentUser }
  | { status: 'new_password_required'; username: string; session: string };

export const getCurrentUser = (): CurrentUser => {
  const idToken = getStoredValue(ID_TOKEN_KEY);
  const username = getStoredValue(USERNAME_KEY);
  if (!idToken || !username) return null;
  if (Date.now() >= getTokenExpiryMs(idToken)) {
    return null;
  }
  const payload = parseJwtPayload(idToken);
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const preferredUsername = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
  const cognitoUsername = typeof payload['cognito:username'] === 'string' ? payload['cognito:username'] as string : undefined;
  const displayName = preferredUsername || email || cognitoUsername || username;
  return {
    username,
    email,
    displayName,
    groups: Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : []
  };
};

export const signIn = async (username: string, password: string, keepSignedIn = true): Promise<SignInResult> => {
  requireClientId();
  localStorage.setItem(AUTH_PERSISTENCE_KEY, keepSignedIn ? 'local' : 'session');
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password
      }
    })
  );

  if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED' && response.Session) {
    return { status: 'new_password_required', username, session: response.Session };
  }

  if (!response.AuthenticationResult) {
    throw new Error('Sign-in failed');
  }

  persistTokens(username, response.AuthenticationResult);
  return { status: 'authenticated', user: getCurrentUser() };
};

export const setInitialPassword = async (username: string, session: string, newPassword: string): Promise<CurrentUser> => {
  requireClientId();
  const response = await client.send(
    new RespondToAuthChallengeCommand({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: COGNITO_CLIENT_ID,
      Session: session,
      ChallengeResponses: {
        USERNAME: username,
        NEW_PASSWORD: newPassword
      }
    })
  );

  if (!response.AuthenticationResult) {
    throw new Error('Failed to set initial password');
  }

  persistTokens(username, response.AuthenticationResult);
  return getCurrentUser();
};

export const register = async (email: string, password: string): Promise<void> => {
  requireClientId();
  await client.send(
    new SignUpCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }]
    })
  );
};

export const confirmRegistration = async (email: string, code: string): Promise<void> => {
  requireClientId();
  await client.send(new ConfirmSignUpCommand({ ClientId: COGNITO_CLIENT_ID, Username: email, ConfirmationCode: code }));
};

export const forgotPassword = async (email: string): Promise<void> => {
  requireClientId();
  await client.send(new ForgotPasswordCommand({ ClientId: COGNITO_CLIENT_ID, Username: email }));
};

export const confirmForgotPassword = async (email: string, code: string, newPassword: string): Promise<void> => {
  requireClientId();
  await client.send(
    new ConfirmForgotPasswordCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword
    })
  );
};

export const changePassword = async (currentPassword: string, newPassword: string): Promise<void> => {
  const accessToken = getStoredValue(ACCESS_TOKEN_KEY);
  if (!accessToken) {
    throw new Error('Not signed in');
  }
  await client.send(new ChangePasswordCommand({ AccessToken: accessToken, PreviousPassword: currentPassword, ProposedPassword: newPassword }));
};

export const getAuthIdToken = (): string | null => getStoredValue(ID_TOKEN_KEY);

export const getValidIdToken = async (): Promise<string | null> => {
  const idToken = getStoredValue(ID_TOKEN_KEY);
  const username = getStoredValue(USERNAME_KEY);
  if (!idToken || !username) return null;
  const expiryMs = getTokenExpiryMs(idToken);
  if (expiryMs > Date.now() + 30_000) {
    return idToken;
  }

  const refreshToken = getStoredValue(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    clearTokenStorage();
    return null;
  }

  try {
    requireClientId();
    const response = await client.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken
        }
      })
    );
    if (!response.AuthenticationResult?.IdToken || !response.AuthenticationResult?.AccessToken) {
      clearTokenStorage();
      return null;
    }
    persistTokens(username, {
      IdToken: response.AuthenticationResult.IdToken,
      AccessToken: response.AuthenticationResult.AccessToken,
      RefreshToken: refreshToken
    });
    return response.AuthenticationResult.IdToken;
  } catch {
    clearTokenStorage();
    return null;
  }
};

export const signOut = async (): Promise<void> => {
  const accessToken = getStoredValue(ACCESS_TOKEN_KEY);
  try {
    if (accessToken) {
      await client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
    }
  } catch {
    // ignore sign-out errors and clear local state
  }
  clearTokenStorage();
};
