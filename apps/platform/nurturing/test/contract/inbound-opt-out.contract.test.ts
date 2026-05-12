import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processOptOutMessage } from '../../src/consumers/opt-out.consumer.js';
import type { OptOutConsumerDeps } from '../../src/consumers/opt-out.consumer.js';
import type { UnenrollmentDeps } from '../../src/services/unenrollment.js';
import type { SQSClient } from '@aws-sdk/client-sqs';

function makeDeps(overrides: Partial<OptOutConsumerDeps> = {}): OptOutConsumerDeps {
  return {
    sqsClient: {} as unknown as SQSClient,
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/test-queue',
    enrollmentsRepo: { findAllActiveByEntityId: vi.fn().mockResolvedValue([]) } as unknown as OptOutConsumerDeps['enrollmentsRepo'],
    unenroll: vi.fn().mockResolvedValue({ found: true }),
    unenrollDeps: {} as unknown as UnenrollmentDeps,
    publisher: { publishAllSequencesCancelled: vi.fn().mockResolvedValue(undefined) } as unknown as OptOutConsumerDeps['publisher'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as OptOutConsumerDeps['logger'],
    ...overrides,
  };
}

describe('opt_out.received consumer contract — malformed event handling', () => {
  let deps: OptOutConsumerDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('handles missing entity_id — does not throw', async () => {
    await expect(
      processOptOutMessage(JSON.stringify({ event_type: 'opt_out.received', payload: {} }), deps),
    ).resolves.toBeUndefined();
    expect((deps.unenroll as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('handles completely invalid JSON structure — does not throw', async () => {
    await expect(
      processOptOutMessage(null as unknown as string, deps),
    ).resolves.toBeUndefined();
    expect((deps.unenroll as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('handles missing payload — does not throw', async () => {
    await expect(
      processOptOutMessage(JSON.stringify({ event_type: 'opt_out.received' }), deps),
    ).resolves.toBeUndefined();
    expect((deps.unenroll as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('handles unexpected event_type — does not throw', async () => {
    await expect(
      processOptOutMessage(
        JSON.stringify({ event_type: 'some.other.event', payload: { entity_id: 'test' } }),
        deps,
      ),
    ).resolves.toBeUndefined();
    expect((deps.unenroll as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('handles valid opt_out.received — calls unenrollment for all active enrollments', async () => {
    const enrollments = [
      { sequence_id: 'seq-1', entity_type: 'lead', entity_id: 'lead-123' },
      { sequence_id: 'seq-2', entity_type: 'lead', entity_id: 'lead-123' },
    ];
    const findMock = vi.fn().mockResolvedValue(enrollments);
    const unenrollMock = vi.fn().mockResolvedValue({ found: true });
    const publishMock = vi.fn().mockResolvedValue(undefined);

    deps = makeDeps({
      enrollmentsRepo: { findAllActiveByEntityId: findMock } as unknown as OptOutConsumerDeps['enrollmentsRepo'],
      unenroll: unenrollMock,
      publisher: { publishAllSequencesCancelled: publishMock } as unknown as OptOutConsumerDeps['publisher'],
    });

    await processOptOutMessage(JSON.stringify({ detail: { entity_id: 'lead-123' } }), deps);

    expect(findMock).toHaveBeenCalledWith('lead-123');
    expect(unenrollMock).toHaveBeenCalledTimes(2);
    expect(unenrollMock).toHaveBeenCalledWith(
      { sequence_id: 'seq-1', entity_type: 'lead', entity_id: 'lead-123' },
      deps.unenrollDeps,
    );
    expect(unenrollMock).toHaveBeenCalledWith(
      { sequence_id: 'seq-2', entity_type: 'lead', entity_id: 'lead-123' },
      deps.unenrollDeps,
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ entity_id: 'lead-123', cancelled_count: 2 }),
    );
  });

  it('handles unenrollment error on one enrollment — continues processing others and does not throw', async () => {
    const enrollments = [
      { sequence_id: 'seq-1', entity_type: 'lead', entity_id: 'lead-123' },
      { sequence_id: 'seq-2', entity_type: 'lead', entity_id: 'lead-123' },
    ];
    const findMock = vi.fn().mockResolvedValue(enrollments);
    const unenrollMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('unenroll failed'))
      .mockResolvedValueOnce({ found: true });
    const publishMock = vi.fn().mockResolvedValue(undefined);

    deps = makeDeps({
      enrollmentsRepo: { findAllActiveByEntityId: findMock } as unknown as OptOutConsumerDeps['enrollmentsRepo'],
      unenroll: unenrollMock,
      publisher: { publishAllSequencesCancelled: publishMock } as unknown as OptOutConsumerDeps['publisher'],
    });

    await expect(
      processOptOutMessage(JSON.stringify({ detail: { entity_id: 'lead-123' } }), deps),
    ).resolves.toBeUndefined();

    expect(unenrollMock).toHaveBeenCalledTimes(2);
    expect(unenrollMock).toHaveBeenCalledWith(
      { sequence_id: 'seq-2', entity_type: 'lead', entity_id: 'lead-123' },
      deps.unenrollDeps,
    );
  });
});
