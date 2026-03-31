import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  NurturingPublisher,
  type EnrollmentCompletedPayload,
  type EnrollmentUnenrolledPayload,
  type StepFailedPayload,
  type StepOutputReadyPayload,
  type AllSequencesCancelledPayload,
} from '../../src/events/publisher.js';

function makeEbClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as unknown as EventBridgeClient;
}

const BUS_NAME = 'test-bus';

describe('nurturing.* EventBridge event shapes', () => {
  let ebClient: ReturnType<typeof makeEbClient>;
  let publisher: NurturingPublisher;
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ebClient = makeEbClient();
    sendMock = ebClient.send as ReturnType<typeof vi.fn>;
    publisher = new NurturingPublisher(ebClient, BUS_NAME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nurturing.enrollment_completed — payload matches EnrollmentCompletedPayload shape', async () => {
    const payload: EnrollmentCompletedPayload = {
      enrollment_id: 'enroll-1',
      sequence_id: 'seq-1',
      entity_type: 'lead',
      entity_id: 'lead-1',
      completed_at: '2026-03-31T10:00:00.000Z',
    };

    await publisher.publishEnrollmentCompleted(payload);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as PutEventsCommand;
    expect(cmd.input.Entries).toHaveLength(1);
    const entry = cmd.input.Entries![0];
    expect(entry.EventBusName).toBe(BUS_NAME);
    expect(entry.Source).toBe('platform.nurturing');
    expect(entry.DetailType).toBe('nurturing.enrollment_completed');
    const detail = JSON.parse(entry.Detail!) as EnrollmentCompletedPayload;
    expect(detail.enrollment_id).toBe('enroll-1');
    expect(detail.sequence_id).toBe('seq-1');
    expect(detail.entity_type).toBe('lead');
    expect(detail.entity_id).toBe('lead-1');
    expect(detail.completed_at).toBe('2026-03-31T10:00:00.000Z');
  });

  it('nurturing.enrollment_unenrolled — payload matches EnrollmentUnenrolledPayload shape', async () => {
    const payload: EnrollmentUnenrolledPayload = {
      enrollment_id: 'enroll-2',
      sequence_id: 'seq-2',
      entity_type: 'lead',
      entity_id: 'lead-2',
    };

    await publisher.publishEnrollmentUnenrolled(payload);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as PutEventsCommand;
    const entry = cmd.input.Entries![0];
    expect(entry.DetailType).toBe('nurturing.enrollment_unenrolled');
    const detail = JSON.parse(entry.Detail!) as EnrollmentUnenrolledPayload;
    expect(detail.enrollment_id).toBe('enroll-2');
    expect(detail.sequence_id).toBe('seq-2');
    expect(detail.entity_type).toBe('lead');
    expect(detail.entity_id).toBe('lead-2');
  });

  it('nurturing.step_failed — payload matches StepFailedPayload shape', async () => {
    const payload: StepFailedPayload = {
      enrollment_id: 'enroll-3',
      step_id: 'step-1',
      entity_type: 'lead',
      entity_id: 'lead-3',
      error: 'ai_complete_failed',
      attempt: 3,
    };

    await publisher.publishStepFailed(payload);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as PutEventsCommand;
    const entry = cmd.input.Entries![0];
    expect(entry.DetailType).toBe('nurturing.step_failed');
    const detail = JSON.parse(entry.Detail!) as StepFailedPayload;
    expect(detail.enrollment_id).toBe('enroll-3');
    expect(detail.step_id).toBe('step-1');
    expect(detail.entity_type).toBe('lead');
    expect(detail.entity_id).toBe('lead-3');
    expect(detail.error).toBe('ai_complete_failed');
    expect(detail.attempt).toBe(3);
  });

  it('nurturing.step_output_ready — payload matches StepOutputReadyPayload shape', async () => {
    const payload: StepOutputReadyPayload = {
      enrollment_id: 'enroll-4',
      step_id: 'step-2',
      entity_type: 'lead',
      entity_id: 'lead-4',
    };

    await publisher.publishStepOutputReady(payload);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as PutEventsCommand;
    const entry = cmd.input.Entries![0];
    expect(entry.DetailType).toBe('nurturing.step_output_ready');
    const detail = JSON.parse(entry.Detail!) as StepOutputReadyPayload;
    expect(detail.enrollment_id).toBe('enroll-4');
    expect(detail.step_id).toBe('step-2');
    expect(detail.entity_type).toBe('lead');
    expect(detail.entity_id).toBe('lead-4');
  });

  it('nurturing.all_sequences_cancelled — payload matches AllSequencesCancelledPayload shape', async () => {
    const payload: AllSequencesCancelledPayload = {
      entity_type: 'lead',
      entity_id: 'lead-5',
      cancelled_count: 4,
    };

    await publisher.publishAllSequencesCancelled(payload);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as PutEventsCommand;
    const entry = cmd.input.Entries![0];
    expect(entry.DetailType).toBe('nurturing.all_sequences_cancelled');
    const detail = JSON.parse(entry.Detail!) as AllSequencesCancelledPayload;
    expect(detail.entity_type).toBe('lead');
    expect(detail.entity_id).toBe('lead-5');
    expect(detail.cancelled_count).toBe(4);
  });

  it('all events use Source = platform.nurturing and correct EventBusName', async () => {
    await publisher.publishEnrollmentCompleted({
      enrollment_id: 'e1', sequence_id: 's1', entity_type: 'lead', entity_id: 'l1', completed_at: new Date().toISOString(),
    });

    const cmd = sendMock.mock.calls[0][0] as PutEventsCommand;
    const entry = cmd.input.Entries![0];
    expect(entry.Source).toBe('platform.nurturing');
    expect(entry.EventBusName).toBe(BUS_NAME);
  });
});
