#!/usr/bin/env node
import { Command } from 'commander';
import { registerLoginCommand }         from './commands/login.js';
import { registerConfigCommands }       from './commands/config.js';
import { registerLeadsCommands }        from './commands/leads.js';
import { registerPipelineCommands }     from './commands/pipeline.js';
import { registerConversationsCommands } from './commands/conversations.js';

const program = new Command();

program
  .name('crm')
  .description('CRM debug CLI — test and inspect backend modules via the API Gateway')
  .version('1.0.0');

registerLoginCommand(program);
registerConfigCommands(program);
registerLeadsCommands(program);
registerPipelineCommands(program);
registerConversationsCommands(program);

program.parse();
