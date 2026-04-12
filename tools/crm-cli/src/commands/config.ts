import type { Command } from 'commander';
import { readConfig, updateConfig } from '../config.js';
import { printKeyValue, printSuccess, printError } from '../output.js';

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Manage CLI configuration');

  config
    .command('show')
    .description('Show current configuration')
    .action(() => {
      const cfg = readConfig();
      printKeyValue({
        gateway_url:   cfg.gateway_url,
        gotrue_url:    cfg.gotrue_url,
        identity_url:  cfg.identity_url,
        access_token:  cfg.access_token  ? `${cfg.access_token.slice(0, 20)}...` : '(not set)',
        refresh_token: cfg.refresh_token ? '(set)' : '(not set)',
      }, 'CRM CLI Configuration');
    });

  config
    .command('set-url <url>')
    .description('Update gateway URL without re-authenticating')
    .action((url: string) => {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        printError('URL must start with http:// or https://');
        process.exit(1);
      }
      updateConfig({ gateway_url: url });
      printSuccess(`Gateway URL updated to ${url}`);
    });
}
