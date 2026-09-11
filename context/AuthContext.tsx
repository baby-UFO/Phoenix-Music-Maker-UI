import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { authApi, User } from '../services/api';
import { lsSet, lsRemove, storageKeys } from '../utils/phoenixStorage';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  setupUser: (username: string) => Promise<void>;
  updateUsername: (username: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = storageKeys.token.primary;
const TOKEN_LEGACY = storageKeys.token.legacy;
const USER_KEY = storageKeys.user.primary;
const USER_LEGACY = storageKeys.user.legacy;

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  // Start with null - we'll auto-login from database on mount
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user && !!token;

  // Silent local identity on mount — never open a login wall on API blip
  useEffect(() => {
    async function initAuth(): Promise<void> {
      const cachedToken = typeof localStorage !== 'undefined'
        ? (localStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_LEGACY || ''))
        : null;
      const cachedUserRaw = typeof localStorage !== 'undefined'
        ? (localStorage.getItem(USER_KEY) || localStorage.getItem(USER_LEGACY || ''))
        : null;
      if (cachedToken && cachedUserRaw) {
        try {
          const cachedUser = JSON.parse(cachedUserRaw) as User;
          setToken(cachedToken);
          setUser(cachedUser);
        } catch { /* ignore bad cache */ }
      }

      try {
        const { user: userData, token: newToken } = await authApi.auto();
        setUser(userData);
        setToken(newToken);
        try {
          localStorage.setItem(TOKEN_KEY, newToken);
          localStorage.setItem(USER_KEY, JSON.stringify(userData));
          if (TOKEN_LEGACY) localStorage.removeItem(TOKEN_LEGACY);
          if (USER_LEGACY) localStorage.removeItem(USER_LEGACY);
        } catch { /* ignore */ }
      } catch (error: unknown) {
        console.warn('Auto-login failed (keeping cache if any):', error);
        // Do NOT wipe cache / force UsernameModal — zero-auth OSS
        if (!cachedToken) {
          try {
            const { user: userData, token: newToken } = await authApi.setup(
              (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.PMM_DEFAULT_USERNAME) || 'babyUFO'
            );
            setUser(userData);
            setToken(newToken);
            localStorage.setItem(TOKEN_KEY, newToken);
            localStorage.setItem(USER_KEY, JSON.stringify(userData));
          } catch (setupErr) {
            console.warn('Silent setup failed:', setupErr);
          }
        }
      } finally {
        setIsLoading(false);
      }
    }

    initAuth();
  }, []);

  const setupUser = useCallback(async (username: string): Promise<void> => {
    const { user: userData, token: newToken } = await authApi.setup(username);
    setUser(userData);
    setToken(newToken);
    lsSet(TOKEN_KEY, newToken, TOKEN_LEGACY);
    lsSet(USER_KEY, JSON.stringify(userData), USER_LEGACY);
  }, []);

  const updateUsername = useCallback(async (username: string): Promise<void> => {
    if (!token) throw new Error('Not authenticated');
    const { user: userData, token: newToken } = await authApi.updateUsername(username, token);
    setUser(userData);
    setToken(newToken);
    lsSet(TOKEN_KEY, newToken, TOKEN_LEGACY);
    lsSet(USER_KEY, JSON.stringify(userData), USER_LEGACY);
  }, [token]);

  const logout = useCallback((): void => {
    authApi.logout().catch(() => {});
    setUser(null);
    setToken(null);
    lsRemove(TOKEN_KEY, TOKEN_LEGACY);
    lsRemove(USER_KEY, USER_LEGACY);
  }, []);

  const refreshUser = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      const { user: userData } = await authApi.me(token);
      setUser(userData);
      lsSet(USER_KEY, JSON.stringify(userData), USER_LEGACY);
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  }, [token]);

  const value: AuthContextType = {
    user,
    token,
    isLoading,
    isAuthenticated,
    setupUser,
    updateUsername,
    logout,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
