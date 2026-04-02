export interface AuthProvider {
  verifyToken(token: string): Promise<{ providerUserId: string; email: string }>;
  createUser(email: string, password: string): Promise<{ providerUserId: string }>;
  setPassword(providerUserId: string, password: string): Promise<void>;
  deactivateUser(providerUserId: string): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<void>;
}
