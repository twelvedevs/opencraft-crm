import type { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import { request } from '../client.js';
import { printJson, printTable, printKeyValue, printSuccess, printError } from '../output.js';
import { withGlobals, handleError, type GlobalOpts } from '../util.js';

interface Location {
  id: string;
  name: string;
  phone: string;
  address: string;
  timezone: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const required = (v: string) => v.trim() ? true : 'Required';

export function registerLocationsCommands(program: Command): void {
  const locations = program.command('locations').description('Manage practice locations');

  // crm locations list
  withGlobals(locations.command('list'))
    .description('List all locations')
    .option('--status <status>', 'Filter by status: active | inactive')
    .action(async (opts: GlobalOpts & { status?: string }) => {
      try {
        const qs = opts.status ? `?status=${opts.status}` : '';
        const data = await request(`/locations${qs}`, { token: opts.token, gatewayUrl: opts.url }) as { locations: Location[] };
        if (opts.json) { printJson(data); return; }
        if (!data.locations.length) { console.log('No locations found.'); return; }
        printTable(
          ['ID', 'Name', 'Phone', 'Timezone', 'Status'],
          data.locations.map(l => [l.id.slice(0, 8) + '…', l.name, l.phone, l.timezone, l.status]),
        );
      } catch (err) { handleError(err); }
    });

  // crm locations get <id>
  withGlobals(locations.command('get <id>'))
    .description('Get a location by ID')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const loc = await request(`/locations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Location;
        if (opts.json) { printJson(loc); return; }
        printKeyValue({
          id:         loc.id,
          name:       loc.name,
          phone:      loc.phone,
          address:    loc.address,
          timezone:   loc.timezone,
          status:     loc.status,
          created_at: loc.created_at,
          updated_at: loc.updated_at,
        }, `Location: ${loc.name}`);
      } catch (err) { handleError(err); }
    });

  // crm locations create
  withGlobals(locations.command('create'))
    .description('Create a new location (interactive)')
    .action(async (opts: GlobalOpts) => {
      try {
        const name     = await input({ message: 'Name:',     validate: required });
        const phone    = await input({ message: 'Phone:',    validate: required });
        const address  = await input({ message: 'Address:',  validate: required });
        const timezone = await input({ message: 'Timezone (IANA, e.g. America/New_York):', validate: required });

        const loc = await request('/locations', {
          method: 'POST',
          body: { name, phone, address, timezone },
          token: opts.token,
          gatewayUrl: opts.url,
        }) as Location;

        if (opts.json) { printJson(loc); return; }
        printSuccess(`Location created: ${loc.name} (${loc.id})`);
      } catch (err) { handleError(err); }
    });

  // crm locations update <id>
  withGlobals(locations.command('update <id>'))
    .description('Update a location (interactive, pre-filled with current values)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const current = await request(`/locations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Location;

        const name     = await input({ message: 'Name:',     default: current.name });
        const phone    = await input({ message: 'Phone:',    default: current.phone });
        const address  = await input({ message: 'Address:',  default: current.address });
        const timezone = await input({ message: 'Timezone:', default: current.timezone });
        const status   = await select({
          message: 'Status:',
          choices: [{ value: 'active' }, { value: 'inactive' }],
          default: current.status,
        });

        const body: Record<string, string> = {};
        if (name !== current.name)         body['name'] = name;
        if (phone !== current.phone)       body['phone'] = phone;
        if (address !== current.address)   body['address'] = address;
        if (timezone !== current.timezone) body['timezone'] = timezone;
        if (status !== current.status)     body['status'] = status;

        if (!Object.keys(body).length) { console.log('No changes made.'); return; }

        const loc = await request(`/locations/${id}`, {
          method: 'PATCH',
          body,
          token: opts.token,
          gatewayUrl: opts.url,
        }) as Location;

        if (opts.json) { printJson(loc); return; }
        printSuccess(`Location updated: ${loc.name}`);
      } catch (err) { handleError(err); }
    });

  // crm locations deactivate <id>
  withGlobals(locations.command('deactivate <id>'))
    .description('Deactivate a location (sets status=inactive)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const current = await request(`/locations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Location;
        const confirmed = await confirm({
          message: `Deactivate "${current.name}"? This cannot be undone via CLI.`,
          default: false,
        });
        if (!confirmed) { console.log('Cancelled.'); return; }

        await request(`/locations/${id}`, {
          method: 'DELETE',
          token: opts.token,
          gatewayUrl: opts.url,
        });

        printSuccess(`Location deactivated: ${current.name}`);
      } catch (err) {
        const error = err as { body?: { error?: string } };
        if (error.body?.error === 'location_has_users') {
          printError('Cannot deactivate: location still has users assigned. Reassign them first.');
          return;
        }
        handleError(err);
      }
    });
}
