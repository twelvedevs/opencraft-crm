import type { Command } from 'commander';
import { input } from '@inquirer/prompts';
import { request } from '../client.js';
import { printJson, printTable, printKeyValue, printSuccess, colorizeStatus } from '../output.js';
import { withGlobals, handleError, type GlobalOpts } from '../util.js';
import { promptMessageBody } from '../prompts/conv-prompts.js';
import chalk from 'chalk';

interface Conversation {
  id: string;
  lead_id: string;
  location_id: string;
  status: string;
  assigned_to?: string | null;
  agent_mode_active: boolean;
  last_message_at?: string | null;
  [key: string]: unknown;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
  [key: string]: unknown;
}

interface Note {
  id: string;
  body: string;
  created_at: string;
  author_id: string;
  [key: string]: unknown;
}

function formatMessage(m: Message): string {
  const arrow = m.direction === 'inbound' ? chalk.cyan('←') : chalk.green('→');
  const time  = new Date(m.created_at).toLocaleTimeString();
  return `  ${arrow} [${time}] ${m.body}`;
}

export function registerConversationsCommands(program: Command): void {
  const conversations = program.command('conversations').description('Manage conversations');

  // crm conversations list
  withGlobals(conversations.command('list'))
    .description('List conversations at a location')
    .option('--location <id>',        'Location ID (required)')
    .option('--lead <id>',            'Filter by lead ID')
    .option('--status <open|closed>', 'Filter by status')
    .action(async (opts: GlobalOpts & { location?: string; lead?: string; status?: string }) => {
      try {
        let locationId = opts.location;
        if (!locationId) {
          locationId = await input({ message: 'Location ID:' });
        }

        const params = new URLSearchParams({ location_id: locationId });
        if (opts.lead)   params.set('lead_id', opts.lead);
        if (opts.status) params.set('status', opts.status);

        const data = await request(`/conversations?${params}`, {
          token: opts.token, gatewayUrl: opts.url,
        }) as { conversations: Conversation[]; total: number };

        if (opts.json) { printJson(data); return; }

        if (!data.conversations.length) { console.log('No conversations found.'); return; }

        printTable(
          ['ID', 'Lead ID', 'Status', 'Assigned To', 'Last Message'],
          data.conversations.map(c => [
            c.id.slice(0, 8) + '…',
            c.lead_id.slice(0, 8) + '…',
            colorizeStatus(c.status),
            c.assigned_to ? c.assigned_to.slice(0, 8) + '…' : '—',
            c.last_message_at ? new Date(c.last_message_at).toLocaleString() : '—',
          ]),
        );
      } catch (err) { handleError(err); }
    });

  // crm conversations get <id>
  withGlobals(conversations.command('get <id>'))
    .description('Get conversation with last 20 messages')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const [conv, msgData] = await Promise.all([
          request(`/conversations/${id}`, { token: opts.token, gatewayUrl: opts.url }) as Promise<Conversation>,
          request(`/conversations/${id}/messages?limit=20`, { token: opts.token, gatewayUrl: opts.url }) as Promise<{ messages: Message[] }>,
        ]);

        if (opts.json) { printJson({ conversation: conv, messages: msgData.messages }); return; }

        printKeyValue({
          id:               conv.id,
          lead_id:          conv.lead_id,
          location_id:      conv.location_id,
          status:           colorizeStatus(conv.status),
          assigned_to:      conv.assigned_to ?? '—',
          agent_mode:       conv.agent_mode_active ? 'active' : 'off',
        }, 'Conversation');

        console.log('');
        console.log(chalk.bold('Messages (oldest → newest):'));
        if (!msgData.messages.length) {
          console.log('  (no messages)');
        } else {
          for (const m of [...msgData.messages].reverse()) {
            console.log(formatMessage(m));
          }
        }
      } catch (err) { handleError(err); }
    });

  // crm conversations send <id>
  withGlobals(conversations.command('send <id>'))
    .description('Send a message in a conversation (opens editor)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const body = await promptMessageBody('Message body (save and close editor to send):');
        if (!body.trim()) { console.log('Empty message — aborted.'); return; }

        const msg = await request(`/conversations/${id}/messages`, {
          method: 'POST', body: { body: body.trim() }, token: opts.token, gatewayUrl: opts.url,
        }) as Message;

        if (opts.json) { printJson(msg); return; }
        printSuccess(`Message sent (${msg.id})`);
      } catch (err) { handleError(err); }
    });

  // crm conversations note <id>
  withGlobals(conversations.command('note <id>'))
    .description('Add an internal note to a conversation (opens editor)')
    .action(async (id: string, opts: GlobalOpts) => {
      try {
        const body = await promptMessageBody('Note body (save and close editor to submit):');
        if (!body.trim()) { console.log('Empty note — aborted.'); return; }

        const note = await request(`/conversations/${id}/notes`, {
          method: 'POST', body: { body: body.trim() }, token: opts.token, gatewayUrl: opts.url,
        }) as Note;

        if (opts.json) { printJson(note); return; }
        printSuccess(`Note added (${note.id})`);
      } catch (err) { handleError(err); }
    });
}
