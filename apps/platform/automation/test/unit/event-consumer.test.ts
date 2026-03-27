import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParseError } from '../../src/events/inbound-event.js';
import type { InboundEvent } from '../../src/events/inbound-event.js';
import type { RuleMatcher, MatchedRule } from '../../src/services/rule-matcher.js';
import type { ExecutionManagerPort } from '../../src/services/event-consumer.js';

vi.mock('../../src/events/inbound-event.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/events/inbound-event.js')>();
  return {
    ...actual,
    parseEventBridgeMessage: vi.fn(),
  };
});

import { parseEventBridgeMessage } from '../../src/events/inbound-event.js';
import { EventConsumer } from '../../src/services/event-consumer.js';

const makeEvent = (): InboundEvent => ({
  event_id: 'evt-1',
  event_type: 'lead.created',
  entity_type: 'lead',
  entity_id: 'lead-42',
  payload: {},
});

const makeMatchedRule = (id: string): MatchedRule =>
  ({
    rule: { rule_id: id, rule_name: `Rule ${id}`, rule_version: 1, trigger_event_type: 'lead.created', condition: null, active_hours: null, action_tree: {} },
    execCtx: { event_id: 'evt-1', execution_id: 'exec-1', rule_id: id, rule_version: 1 },
  }) as MatchedRule;

const makeMatcher = (matched: MatchedRule[]): RuleMatcher =>
  ({ matchRules: vi.fn().mockResolvedValue(matched) }) as unknown as RuleMatcher;

const makeExecManager = (): ExecutionManagerPort =>
  ({ handle: vi.fn().mockResolvedValue(undefined) }) as unknown as ExecutionManagerPort;

const makeLogger = () => ({ info: vi.fn(), error: vi.fn() });

describe('EventConsumer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('valid body — parseEventBridgeMessage called, matchRules called, handle called once per matched rule', async () => {
    const event = makeEvent();
    vi.mocked(parseEventBridgeMessage).mockReturnValue(event);
    const rule = makeMatchedRule('r1');
    const matcher = makeMatcher([rule]);
    const execManager = makeExecManager();
    const logger = makeLogger();

    const consumer = new EventConsumer(matcher, execManager, logger);
    await consumer.process('{"detail":{}}');

    expect(parseEventBridgeMessage).toHaveBeenCalledWith('{"detail":{}}');
    expect(matcher.matchRules).toHaveBeenCalledWith(event);
    expect(execManager.handle).toHaveBeenCalledTimes(1);
    expect(execManager.handle).toHaveBeenCalledWith(rule, event);
  });

  it('two matched rules — handle called twice with correct args', async () => {
    const event = makeEvent();
    vi.mocked(parseEventBridgeMessage).mockReturnValue(event);
    const r1 = makeMatchedRule('r1');
    const r2 = makeMatchedRule('r2');
    const matcher = makeMatcher([r1, r2]);
    const execManager = makeExecManager();
    const logger = makeLogger();

    const consumer = new EventConsumer(matcher, execManager, logger);
    await consumer.process('{}');

    expect(execManager.handle).toHaveBeenCalledTimes(2);
    expect(execManager.handle).toHaveBeenNthCalledWith(1, r1, event);
    expect(execManager.handle).toHaveBeenNthCalledWith(2, r2, event);
  });

  it('no matched rules — handle never called', async () => {
    const event = makeEvent();
    vi.mocked(parseEventBridgeMessage).mockReturnValue(event);
    const matcher = makeMatcher([]);
    const execManager = makeExecManager();
    const logger = makeLogger();

    const consumer = new EventConsumer(matcher, execManager, logger);
    await consumer.process('{}');

    expect(execManager.handle).not.toHaveBeenCalled();
  });

  it('ParseError from parseEventBridgeMessage — logged, process resolves without throwing', async () => {
    vi.mocked(parseEventBridgeMessage).mockImplementation(() => {
      throw new ParseError('bad envelope');
    });
    const matcher = makeMatcher([]);
    const execManager = makeExecManager();
    const logger = makeLogger();

    const consumer = new EventConsumer(matcher, execManager, logger);
    await expect(consumer.process('not-valid')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect(matcher.matchRules).not.toHaveBeenCalled();
  });

  it('generic Error from parseEventBridgeMessage — logged, process resolves without throwing', async () => {
    vi.mocked(parseEventBridgeMessage).mockImplementation(() => {
      throw new Error('unexpected failure');
    });
    const matcher = makeMatcher([]);
    const execManager = makeExecManager();
    const logger = makeLogger();

    const consumer = new EventConsumer(matcher, execManager, logger);
    await expect(consumer.process('broken')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect(matcher.matchRules).not.toHaveBeenCalled();
  });
});
