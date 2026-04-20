import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock the AudienceApiClient
vi.mock('../src/api.js', () => ({
  AudienceApiClient: vi.fn().mockImplementation(() => ({
    getSegment: vi.fn().mockResolvedValue({
      segment_id: 'seg-1',
      name: 'New Patient Contacted',
      status: 'active',
      active_version: 1,
      current_version: 1,
      filter: {
        op: 'AND',
        conditions: [
          { field: 'pipeline', op: 'eq', value: 'new_patient' },
          { field: 'stage', op: 'eq', value: 'contacted' },
        ],
      },
    }),
    evaluateInline: vi.fn().mockResolvedValue({ matched_count: 87, entity_ids: [] }),
  })),
}));

import { AudiencePreview } from '../src/AudiencePreview.js';

describe('AudiencePreview', () => {
  it('renders segment name and status badge', async () => {
    render(<AudiencePreview audienceEngineUrl="http://localhost:3000" segmentId="seg-1" />);
    expect(await screen.findByText('New Patient Contacted')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
  });

  it('renders human-readable filter conditions', async () => {
    render(<AudiencePreview audienceEngineUrl="http://localhost:3000" segmentId="seg-1" />);
    await screen.findByText('New Patient Contacted');
    expect(screen.getByText('pipeline equals new_patient')).toBeTruthy();
    expect(screen.getByText('stage equals contacted')).toBeTruthy();
  });

  it('shows estimated count when onFetchEntities provided', async () => {
    const onFetchEntities = vi.fn().mockResolvedValue([{ entity_id: 'e1' }]);
    render(
      <AudiencePreview
        audienceEngineUrl="http://localhost:3000"
        segmentId="seg-1"
        onFetchEntities={onFetchEntities}
      />
    );
    await waitFor(() => expect(screen.getByText(/Estimated audience/)).toBeTruthy());
    expect(screen.getByText('87')).toBeTruthy();
  });

  it('does not show estimated count when onFetchEntities is absent', async () => {
    render(<AudiencePreview audienceEngineUrl="http://localhost:3000" segmentId="seg-1" />);
    await screen.findByText('New Patient Contacted');
    expect(screen.queryByText(/Estimated audience/)).toBeNull();
  });
});
