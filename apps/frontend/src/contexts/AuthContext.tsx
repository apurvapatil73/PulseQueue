import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authApi, type LoginPayload, type RegisterPayload } from '../api/auth.api';
import { onSessionExpired } from '../api/tokenStore';
import type { SafeUser } from '../types/api';

interface AuthContextValue {
  user: SafeUser | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
  login: (payload: LoginPayload) => Promise<SafeUser>;
  register: (payload: RegisterPayload) => Promise<SafeUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<SafeUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const restoredUser = await authApi.restoreSession();
        if (active) {
          setUser(restoredUser);
        }
      } finally {
        if (active) {
          setIsInitializing(false);
        }
      }
    }

    void bootstrap();

    const unsubscribe = onSessionExpired(() => {
      setUser(null);
      queryClient.clear();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

  const login = useCallback(
    async (payload: LoginPayload): Promise<SafeUser> => {
      const authenticatedUser = await authApi.login(payload);
      queryClient.clear();
      setUser(authenticatedUser);
      return authenticatedUser;
    },
    [queryClient],
  );

  const register = useCallback(async (payload: RegisterPayload): Promise<SafeUser> => {
    await authApi.register(payload);
    // Auto-authenticate immediately after registration using the verified credentials
    const authenticatedUser = await authApi.login({
      email: payload.email,
      password: payload.password,
    });
    setUser(authenticatedUser);
    return authenticatedUser;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isInitializing,
      login,
      register,
      logout,
    }),
    [user, isInitializing, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
