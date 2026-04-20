import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SegmentLibrary } from '../src/SegmentLibrary.js';
import type { AudienceApiClient } from '../src/api.js';

function makeClient(overrides: Partial<AudienceApiClient> = {}): AudienceApiClient {
  return {
    listSegments: vi.fn().mockResolvedValue({
      items: [
        { segment_id: 'seg-1', name: 'Draft Seg', status: 'draft', active_version: null, current_version: 1, updated_at: '2026-04-01T00:00:00Z' },
        { segment_id: 'seg-2', name: 'Active Seg', status: 'active', active_version: 2, current_version: 2, updated_at: '2026-04-02T00:00:00Z' },
      ],
      total: 2,
    }),
    activateSegment: vi.fn().mockResolvedValue(undefined),
    disableSegment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AudienceApiClient;
}

describe('SegmentLibrary', () => {
  it('renders segment names', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} />);
    expect(await screen.findByText('Draft Seg')).toBeTruthy();
    expect(screen.getByText('Active Seg')).toBeTruthy();
  });

  it('shows Edit button only for draft segments', async () => {
    const onEdit = vi.fn();
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} onEditSegment={onEdit} />);
    await screen.findByText('Draft Seg');
    const editBtns = screen.getAllByText('Edit');
    expect(editBtns).toHaveLength(1);
    fireEvent.click(editBtns[0]!);
    expect(onEdit).toHaveBeenCalledWith('seg-1');
  });

  it('hides Activate when canActivate is false', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} canActivate={false} />);
    await screen.findByText('Draft Seg');
    expect(screen.queryByText('Activate')).toBeNull();
  });

  it('shows Activate for draft when canActivate is true', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} canActivate={true} />);
    await screen.findByText('Draft Seg');
    expect(screen.getByText('Activate')).toBeTruthy();
  });

  it('shows Disable for active segments', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} />);
    await screen.findByText('Active Seg');
    expect(screen.getByText('Disable')).toBeTruthy();
  });

  it('calls onSelectSegment when Use is clicked', async () => {
    const onSelect = vi.fn();
    render(<SegmentLibrary client={makeClient()} onSelectSegment={onSelect} onCreateNew={vi.fn()} />);
    await screen.findByText('Draft Seg');
    const useBtns = screen.getAllByText('Use');
    fireEvent.click(useBtns[0]!);
    expect(onSelect).toHaveBeenCalledWith('seg-1');
  });

  it('calls activateSegment and refreshes list on Activate', async () => {
    const client = makeClient();
    render(<SegmentLibrary client={client} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} canActivate={true} />);
    await screen.findByText('Draft Seg');
    fireEvent.click(screen.getByText('Activate'));
    await waitFor(() => expect(client.activateSegment).toHaveBeenCalledWith('seg-1'));
    expect(client.listSegments).toHaveBeenCalledTimes(2);
  });

  it('calls disableSegment and refreshes list on Disable', async () => {
    const client = makeClient();
    render(<SegmentLibrary client={client} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} />);
    await screen.findByText('Active Seg');
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() => expect(client.disableSegment).toHaveBeenCalledWith('seg-2'));
    expect(client.listSegments).toHaveBeenCalledTimes(2);
  });
});
