/**
 * In-memory short-lived access token store.
 *
 * Security policy:
 * - Access tokens live strictly in memory (never written to localStorage or sessionStorage).
 * - Refresh tokens are managed exclusively via HttpOnly SameSite cookies set by the backend.
 */

type SessionExpiredListener = () => void;

let accessToken: string | null = null;
const expiredListeners = new Set<SessionExpiredListener>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  expiredListeners.add(listener);
  return () => {
    expiredListeners.delete(listener);
  };
}

export function notifySessionExpired(): void {
  accessToken = null;
  for (const listener of expiredListeners) {
    listener();
  }
}
