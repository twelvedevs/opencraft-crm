import type { Command } from 'commander';
import { input } from '@inquirer/prompts';
import { request } from '../client.js';
import { printJson, printTable, printKeyValue, printSuccess, colorizeStatus } from '../output.js';
import { withGlobals, handleError, type GlobalOpts } from '../util.js';
import { promptCreateLead, promptUpdateLead } from '../prompts/lead-prompts.js';

interface Lead {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email?: string | null;
  channel: string;
  current_pipeline: string;
  current_stage: string | null;
  score: number;
  treatment_interest?: string | null;
  location_id?: string | null;
  first_touch_source?: string | null;
  first_touch_campaign?: string | null;
  created_at: string;
  last_activity_at?: string | null;
  [key: string]: unknown;
}

export function registerLeadsCommands(program: Command): void {
  const leads = program.command('leads').description('Manage leads');

  // crm leads list
  withGlobals(leads.command('list'))
    .description('List leads')
    .option('--location <id>',   'Filter by location_id')
    .option('--pipeline <name>', 'Filter: new_patient | in_treatment | in_retention')
    .option('--stage <name>',    'Filter by stage')
    .option('--q <search>',      'Search by name, phone, or email')
    .option('--limit <n>',       'Max results (default: 20)', '20')
    .action(async (opts: GlobalOpts & { location?: string; pipeline?: string; stage?: string; q?: string; limit?: string }) => {
      try {
        let locationId = opts.location;
        if (!locationId) {
          locationId = (await input({ message: 'Location ID (leave blank for all):', default: '' })) || undefined;
        }

        const params = new URLSearchParams();
        if (locationId)   params.set('location_id', locationId);
        if (opts.pipeline) params.set('pipeline', opts.pipeline);
        if (opts.stage)    params.set('stage', opts.stage);
        if (opts.q)        params.set('q', opts.q);
        params.set('limit', opts.limit ?? '20');

        const qs   = params.toString();
        const body = await request(`/leads${qs ? `?${qs}` : ''}`, { token: opts.token, gatewayUrl: opts.url }) as { data: Lead[]; nextCursor: string | null };

        if (opts.json) { printJson(body); return; }

        const leads = body.data;
        if (!leads.length) { console.log('No leads found.'); return; }

        printTable(
          ['ID', 'Name', 'Phone', 'Channel', 'Pipeline', 'Stage', 'Score'],
          leads.map(l => [
            l.id.slice(0, 8) + '…',
            `${l.first_name} ${l.last_name}`,
            l.phone,
            l.channel,
            l.current_pipeline,
            colorizeStatus(l.current_stage ?? '—'),
            l.score,
          ]),
        );
      } catch (err) { handleError(err); }
    });

  // crm leads get <id>
  withGlobals(leads.command('get <id>'))
    .description('Get a lead by ID')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const lead = await request(`/leads/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Lead;
        if (opts.json) { printJson(lead); return; }
        printKeyValue({
          id:                  lead.id,
          name:                `${lead.first_name} ${lead.last_name}`,
          phone:               lead.phone,
          email:               lead.email ?? '—',
          channel:             lead.channel,
          pipeline:            lead.current_pipeline,
          stage:               lead.current_stage ?? '—',
          score:               lead.score,
          treatment_interest:  lead.treatment_interest ?? '—',
          location_id:         lead.location_id ?? '—',
          first_touch_source:  lead.first_touch_source ?? '—',
          first_touch_campaign: lead.first_touch_campaign ?? '—',
          created_at:          lead.created_at,
          last_activity_at:    lead.last_activity_at ?? '—',
        }, `Lead: ${lead.first_name} ${lead.last_name}`);
      } catch (err) { handleError(err); }
    });

  // crm leads create
  withGlobals(leads.command('create'))
    .description('Create a new lead (interactive)')
    .action(async (opts: GlobalOpts) => {
      try {
        const answers = await promptCreateLead();
        const body = Object.fromEntries(
          Object.entries(answers).filter(([, v]) => v !== undefined)
        );
        const lead = await request('/leads', { method: 'POST', body, token: opts.token, gatewayUrl: opts.url }) as Lead;
        if (opts.json) { printJson(lead); return; }
        printSuccess(`Lead created: ${lead.first_name} ${lead.last_name} (${lead.id})`);
      } catch (err) { handleError(err); }
    });

  // crm leads update <id>
  withGlobals(leads.command('update <id>'))
    .description('Update a lead (interactive, shows current values)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const current = await request(`/leads/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Lead;
        const answers = await promptUpdateLead(current as Record<string, unknown>);
        const body = Object.fromEntries(
          Object.entries(answers).filter(([, v]) => v !== undefined && v !== '')
        );
        if (!Object.keys(body).length) { console.log('No changes made.'); return; }
        const lead = await request(`/leads/${id}`, { method: 'PATCH', body, token: opts.token, gatewayUrl: opts.url }) as Lead;
        if (opts.json) { printJson(lead); return; }
        printSuccess(`Lead updated: ${lead.first_name} ${lead.last_name}`);
      } catch (err) { handleError(err); }
    });
}
