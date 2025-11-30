import React, { createContext, useContext, useEffect, useState } from "react";
import type { DataSourceMode } from "../data/localStore";
import { getPreferredMode, setPreferredMode } from "../data/localStore";

type AuthState = {
  isAuthenticated: boolean;
  mode: DataSourceMode;
  userLabel: string | null;
};

type AuthContextValue = {
  auth: AuthState;
  loginWithPasskey: () => Promise<void>;
  logout: () => void;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  isAuthModalOpen: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * AuthProvider prepares the UI for a future passkey + 2FA based login.
 *
 * IMPORTANT:
 * - There is deliberately no real backend interaction here yet.
 * - The login method just simulates authentication so that the UI and mode
 *   switching can be wired without depending on backend readiness.
 * - Later, the `loginWithPasskey` implementation will:
 *     - obtain a challenge from the backend,
 *     - use WebAuthn APIs to sign it with a passkey,
 *     - verify the result on the backend,
 *     - and only then mark the user as authenticated.
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [auth, setAuth] = useState<AuthState>(() => {
    const mode = getPreferredMode();
    return {
      isAuthenticated: false,
      mode,
      userLabel: null,
    };
  });

  const [isAuthModalOpen, setAuthModalOpen] = useState(false);

  const openAuthModal = () => setAuthModalOpen(true);
  const closeAuthModal = () => setAuthModalOpen(false);

  const value: AuthContextValue = {
    auth,
    logout,
    openAuthModal,
    closeAuthModal,
    isAuthModalOpen,
    
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}