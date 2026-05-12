import type { Command } from 'commander';
import { select, confirm } from '@inquirer/prompts';
import { input } from '@inquirer/prompts';
import { request } from '../client.js';
import { printJson, printTable, printSuccess } from '../output.js';
import { withGlobals, handleError, type GlobalOpts } from '../util.js';

type Pipeline = 'new_patient' | 'in_treatment' | 'in_retention';
type Reason   = 'manual' | 'timeout' | 'no_show' | 'import' | 'import_undo';

interface Membership {
  id: string;
  lead_id: string;
  pipeline: Pipeline;
  stage: string;
  status: string;
  entered_at: string;
  [key: string]: unknown;
}

// All valid stages across all pipelines (server validates — client just presents options)
const ALL_STAGES: Record<Pipeline, string[]> = {
  new_patient:   ['new_lead', 'contacted', 'exam_scheduled', 'exam_completed', 'tx_presented', 'contract_signed', 'lost'],
  in_treatment:  ['new_patient', 'in_treatment', 'treatment_complete'],
  in_retention:  ['active_retention', 'recall_due', 'long_term_follow'],
};

const PIPELINE_CHOICES = [
  { value: 'new_patient'  as Pipeline, name: 'New Patient' },
  { value: 'in_treatment' as Pipeline, name: 'In Treatment' },
  { value: 'in_retention' as Pipeline, name: 'In Retention' },
];

const REASON_CHOICES: { value: Reason; name: string }[] = [
  { value: 'manual',      name: 'Manual' },
  { value: 'timeout',     name: 'Timeout' },
  { value: 'no_show',     name: 'No-show' },
  { value: 'import',      name: 'Import' },
  { value: 'import_undo', name: 'Import undo' },
];

export function registerPipelineCommands(program: Command): void {
  const pipeline = program.command('pipeline').description('Manage pipeline memberships');

  // crm pipeline memberships <lead-id>
  withGlobals(pipeline.command('memberships <lead-id>'))
    .description('List pipeline memberships for a lead')
    .action(async (leadId: string, opts: GlobalOpts) => {
      try {
        const body = await request(`/pipeline/memberships?lead_id=${leadId}`, {
          token: opts.token, gatewayUrl: opts.url,
        }) as { data: Membership[]; nextCursor: string | null };

        if (opts.json) { printJson(body); return; }

        const memberships = body.data;
        if (!memberships.length) { console.log('No memberships found.'); return; }

        printTable(
          ['Membership ID', 'Pipeline', 'Stage', 'Status', 'Entered At'],
          memberships.map(m => [
            m.id.slice(0, 8) + '…',
            m.pipeline,
            m.stage,
            m.status,
            new Date(m.entered_at).toLocaleString(),
          ]),
        );
      } catch (err) { handleError(err); }
    });

  // crm pipeline enroll <lead-id>
  withGlobals(pipeline.command('enroll <lead-id>'))
    .description('Enroll a lead in a pipeline (interactive)')
    .action(async (leadId: string, opts: GlobalOpts) => {
      try {
        const pipeline_  = await select({ message: 'Pipeline:', choices: PIPELINE_CHOICES });
        const stage      = await select({
          message: 'Entry stage:',
          choices: ALL_STAGES[pipeline_].map(s => ({ value: s, name: s })),
        });
        const location_id = await input({ message: 'Location ID (UUID):' });
        const reason      = await select<'manual' | 'import'>({
          message: 'Reason:',
          choices: [{ value: 'manual', name: 'Manual' }, { value: 'import', name: 'Import' }],
        });

        const body = { lead_id: leadId, pipeline: pipeline_, stage, location_id, reason };
        const membership = await request('/pipeline/memberships', {
          method: 'POST', body, token: opts.token, gatewayUrl: opts.url,
        }) as Membership;

        if (opts.json) { printJson(membership); return; }
        printSuccess(`Enrolled in ${membership.pipeline} / ${membership.stage} (${membership.id})`);
      } catch (err) { handleError(err); }
    });

  // crm pipeline transition <membership-id>
  withGlobals(pipeline.command('transition <membership-id>'))
    .description('Transition a membership to a new stage (interactive)')
    .option('--pipeline <name>', 'Current pipeline (skips membership lookup)')
    .option('--stage <name>',    'Current stage (shown for reference)')
    .action(async (membershipId: string, opts: GlobalOpts & { pipeline?: string; stage?: string }) => {
      try {
        let currentPipeline: Pipeline;
        if (opts.pipeline) {
          currentPipeline = opts.pipeline as Pipeline;
          if (opts.stage) console.log(`Current: ${opts.pipeline} / ${opts.stage}`);
        } else {
          const current = await request(`/pipeline/memberships/${membershipId}`, {
            token: opts.token, gatewayUrl: opts.url,
          }) as Membership;
          currentPipeline = current.pipeline;
          console.log(`Current: ${current.pipeline} / ${current.stage}`);
        }

        const stage    = await select({
          message: 'Target stage:',
          choices: ALL_STAGES[currentPipeline].map(s => ({ value: s, name: s })),
        });
        const reason   = await select({ message: 'Reason:', choices: REASON_CHOICES });
        const override = await confirm({ message: 'Override transition rules?', default: false });

        const body = { stage, reason, override };
        const membership = await request(`/pipeline/memberships/${membershipId}/transition`, {
          method: 'POST', body, token: opts.token, gatewayUrl: opts.url,
        }) as Membership;

        if (opts.json) { printJson(membership); return; }
        printSuccess(`Transitioned to ${membership.stage}`);
      } catch (err) { handleError(err); }
    });
}
