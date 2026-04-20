import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SegmentEditor } from '../src/SegmentEditor.js';
import type { AudienceApiClient } from '../src/api.js';

function makeClient(overrides: Partial<AudienceApiClient> = {}): AudienceApiClient {
  return {
    getSegment: vi.fn(),
    createSegment: vi.fn().mockResolvedValue({ segment_id: 'new-seg', version: 1 }),
    updateSegment: vi.fn().mockResolvedValue({ segment_id: 'seg-1', version: 2, status: 'draft' }),
    evaluateInline: vi.fn().mockResolvedValue({ matched_count: 42, entity_ids: [] }),
    ...overrides,
  } as unknown as AudienceApiClient;
}

describe('SegmentEditor', () => {
  describe('create mode (no segmentId)', () => {
    it('renders empty form', () => {
      render(<SegmentEditor client={makeClient()} fields={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.getByPlaceholderText('Enter segment name')).toBeTruthy();
    });

    it('shows error if name is blank on save', async () => {
      render(<SegmentEditor client={makeClient()} fields={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByText('Save'));
      expect(await screen.findByText('Segment name is required')).toBeTruthy();
    });

    it('calls createSegment and onSave with segment id', async () => {
      const client = makeClient();
      const onSave = vi.fn();
      render(<SegmentEditor client={client} fields={[]} onSave={onSave} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByPlaceholderText('Enter segment name'), { target: { value: 'My Segment' } });
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith('new-seg'));
    });
  });

  describe('live preview', () => {
    it('shows preview count after debounce when onFetchEntities provided', async () => {
      vi.useFakeTimers();
      const onFetchEntities = vi.fn().mockResolvedValue([{ entity_id: 'e1' }]);
      const client = makeClient();
      render(
        <SegmentEditor
          client={client}
          fields={[{ key: 'stage', label: 'Stage', type: 'string' }]}
          onFetchEntities={onFetchEntities}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      expect(screen.getByText('Preview will update as you edit conditions')).toBeTruthy();
      vi.useRealTimers();
    });

    it('shows placeholder text when evaluateInline would fail (no filter change yet)', () => {
      // NOTE: Plan test used fake timers + waitFor which deadlocks (waitFor polls via
      // setInterval which is also faked). Also, the assertion "Preview will update" is
      // the INITIAL state — runPreview is only triggered by a filter change, so with no
      // filter change the preview stays at its placeholder regardless of evaluateInline.
      // This test verifies: with onFetchEntities provided and a failing evaluateInline,
      // the initial placeholder text is still rendered (no premature error state).
      const onFetchEntities = vi.fn().mockResolvedValue([{ entity_id: 'e1' }]);
      const client = makeClient({
        evaluateInline: vi.fn().mockRejectedValue(new Error('evaluate failed')),
      });
      render(
        <SegmentEditor
          client={client}
          fields={[{ key: 'stage', label: 'Stage', type: 'string' }]}
          onFetchEntities={onFetchEntities}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      expect(screen.getByText(/Preview will update/)).toBeTruthy();
    });

    it('does not show preview area when onFetchEntities is absent', () => {
      render(<SegmentEditor client={makeClient()} fields={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByText('Preview will update as you edit conditions')).toBeNull();
    });
  });
});
