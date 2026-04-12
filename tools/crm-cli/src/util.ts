import type { Command } from 'commander';
import { ApiError, NetworkError } from './client.js';
import { printError } from './output.js';

export interface GlobalOpts {
  json?: boolean;
  token?: string;
  url?: string;
}

/**
 * Adds --json, --token, --url to any leaf command.
 * Call on each .command() before adding local options.
 */
export function withGlobals(cmd: Command): Command {
  return cmd
    .option('--json',          'Output raw JSON (pipeable to jq)')
    .option('--token <token>', 'JWT token override for this call')
    .option('--url <url>',     'Gateway URL override for this call');
}

export function handleError(err: unknown): never {
  if (err instanceof ApiError) {
    printError(err.apiError);
    process.exit(1);
  }
  if (err instanceof NetworkError) {
    printError(err.message);
    process.exit(1);
  }
  throw err;
}
