import { parseEventBridgeMessage, type InboundEvent } from '../events/inbound-event.js';
import type { RuleMatcher, MatchedRule } from './rule-matcher.js';

export interface ExecutionManagerPort {
  handle(rule: MatchedRule, event: InboundEvent): Promise<void>;
}

export class EventConsumer {
  constructor(
    private readonly matcher: RuleMatcher,
    private readonly executionManager: ExecutionManagerPort,
    private readonly logger: Pick<Console, 'info' | 'error'> = console,
  ) {}

  async process(body: string): Promise<void> {
    let event: InboundEvent;
    try {
      event = parseEventBridgeMessage(body);
    } catch (err) {
      this.logger.error(err instanceof Error ? err.message : String(err));
      return;
    }

    const matched = await this.matcher.matchRules(event);
    for (const rule of matched) {
      await this.executionManager.handle(rule, event);
    }
  }
}
