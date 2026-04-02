const minLength = parseInt(process.env['PASSWORD_MIN_LENGTH'] ?? '12', 10);
const requireUppercase = process.env['PASSWORD_REQUIRE_UPPERCASE'] !== 'false';
const requireLowercase = process.env['PASSWORD_REQUIRE_LOWERCASE'] !== 'false';
const requireNumber = process.env['PASSWORD_REQUIRE_NUMBER'] !== 'false';
const requireSpecial = process.env['PASSWORD_REQUIRE_SPECIAL'] !== 'false';

export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < minLength) {
    errors.push(`minimum ${minLength} characters required`);
  }

  if (requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('at least one uppercase letter required');
  }

  if (requireLowercase && !/[a-z]/.test(password)) {
    errors.push('at least one lowercase letter required');
  }

  if (requireNumber && !/\d/.test(password)) {
    errors.push('at least one digit required');
  }

  if (requireSpecial && !/[^a-zA-Z0-9]/.test(password)) {
    errors.push('at least one special character required');
  }

  return { valid: errors.length === 0, errors };
}
