import type { Command } from 'commander';
import { input, password } from '@inquirer/prompts';
import { readConfig, writeConfig } from '../config.js';
import { printSuccess, printError } from '../output.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate and store token in ~/.crm/config.json')
    .action(async () => {
      const config = readConfig();

      const email = await input({ message: 'Email:' });
      const pass  = await password({ message: 'Password:', mask: '*' });

      // Step 1: GoTrue — exchange email/password for provider token
      let providerToken: string;
      try {
        const res = await fetch(`${config.gotrue_url}/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ email, password: pass }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error_description?: string };
          printError(`Authentication failed: ${err.error_description ?? 'invalid credentials'}`);
          process.exit(1);
        }
        const data = await res.json() as { access_token: string };
        providerToken = data.access_token;
      } catch {
        printError(`Cannot reach auth server at ${config.gotrue_url}. Is the stack running?`);
        process.exit(1);
      }

      // Step 2: Identity Service — exchange provider token for CRM JWT
      try {
        const res = await fetch(`${config.identity_url}/identity/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider_token: providerToken }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          printError(`Session exchange failed: ${err.error ?? 'unknown error'}`);
          process.exit(1);
        }
        const session = await res.json() as { access_token: string; refresh_token: string };
        writeConfig({ ...config, access_token: session.access_token, refresh_token: session.refresh_token });
        printSuccess('Logged in. Token saved to ~/.crm/config.json');
      } catch {
        printError(`Cannot reach Identity Service at ${config.identity_url}. Is the stack running?`);
        process.exit(1);
      }
    });
}
