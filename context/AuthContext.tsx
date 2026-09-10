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

  // Auto-login on mount: Try to get existing user from database
  useEffect(() => {
    async function initAuth(): Promise<void> {
      try {
        // First, try auto-login from database (for local single-user app)
        const { user: userData, token: newToken } = await authApi.auto();
        setUser(userData);
        setToken(newToken);
        lsSet(TOKEN_KEY, newToken, TOKEN_LEGACY);
        lsSet(USER_KEY, JSON.stringify(userData), USER_LEGACY);
      } catch (error: unknown) {
        // No user in database (404) or server error - that's okay
        // Clear any stale localStorage data
        const err = error as { message?: string };
        if (err.message?.startsWith('404:')) {
          // No user exists yet - frontend will show username setup
          console.log('No user in database, need to set up username');
        } else {
          console.warn('Auto-login failed:', error);
        }
        // Clear stale data
        setToken(null);
        setUser(null);
        lsRemove(TOKEN_KEY, TOKEN_LEGACY);
        lsRemove(USER_KEY, USER_LEGACY);
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
