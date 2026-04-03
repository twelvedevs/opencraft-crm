export interface AuthProvider {
  verifyToken(token: string): Promise<{ providerUserId: string; email: string }>;
  createUser(email: string, password: string): Promise<{ providerUserId: string }>;
  setPassword(providerUserId: string, password: string): Promise<void>;
  deactivateUser(providerUserId: string): Promise<void>;
  /**
   * Verifies the user's current credentials by performing a live sign-in check with the
   * auth provider. Used by the voluntary password-change flow (PUT /me/password when
   * must_change_password is false) to confirm the caller knows their existing password.
   * Throws on invalid credentials. Not part of the original spec's four-method interface
   * because the spec describes it as "AuthProvider.verifyToken equivalent" — this separate
   * method is cleaner than reusing verifyToken (which validates a token, not credentials).
   * All future AuthProvider implementations must include this method.
   */
  signInWithPassword(email: string, password: string): Promise<void>;
}
