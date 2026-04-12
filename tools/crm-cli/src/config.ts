import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CrmConfig {
  gateway_url: string;
  gotrue_url: string;
  identity_url: string;
  access_token?: string;
  refresh_token?: string;
}

const DEFAULTS: CrmConfig = {
  gateway_url: 'http://localhost:3000',
  gotrue_url:  'http://localhost:9999',
  identity_url: 'http://localhost:3100',
};

const CONFIG_DIR  = path.join(os.homedir(), '.crm');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function readConfig(): CrmConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<CrmConfig>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(config: CrmConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function updateConfig(updates: Partial<CrmConfig>): void {
  writeConfig({ ...readConfig(), ...updates });
}

export function resolveToken(override?: string): string | undefined {
  if (override) return override;
  if (process.env['CRM_TOKEN']) return process.env['CRM_TOKEN'];
  return readConfig().access_token;
}
