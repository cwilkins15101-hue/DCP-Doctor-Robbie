import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type Configuration,
} from '@azure/msal-browser';
import { env } from './environment';

export type { AccountInfo };

const msalConfig: Configuration = {
  auth: {
    clientId: env.entra.clientId,
    authority: `https://login.microsoftonline.com/${env.entra.tenantId}`,
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

export const msalInstance = new PublicClientApplication(msalConfig);

export async function initMsal(): Promise<void> {
  await msalInstance.initialize();
  const result = await msalInstance.handleRedirectPromise();
  if (result?.account) {
    msalInstance.setActiveAccount(result.account);
  }
}

export function getActiveAccount(): AccountInfo | null {
  return msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0] ?? null;
}

export async function signIn(): Promise<AccountInfo> {
  const result = await msalInstance.loginPopup({ scopes: ['User.Read'] });
  msalInstance.setActiveAccount(result.account);
  return result.account;
}

export function signOut(): void {
  const account = getActiveAccount();
  msalInstance.logoutPopup(account ? { account } : undefined);
}

/**
 * Passed to the Dragon Copilot SDK as `authentication.acquireAccessToken`.
 * The SDK calls this whenever it needs a token for a given scope; MSAL supplies it.
 */
export async function acquireAccessToken(scope: string): Promise<{ accessToken: string; expiresOn?: Date }> {
  const account = getActiveAccount();
  if (!account) {
    throw new Error('No signed-in account — call signIn() before initializing the Dragon Copilot SDK.');
  }
  try {
    const result = await msalInstance.acquireTokenSilent({ scopes: [scope], account });
    return { accessToken: result.accessToken, expiresOn: result.expiresOn ?? undefined };
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      const result = await msalInstance.acquireTokenPopup({ scopes: [scope], account });
      return { accessToken: result.accessToken, expiresOn: result.expiresOn ?? undefined };
    }
    throw err;
  }
}
