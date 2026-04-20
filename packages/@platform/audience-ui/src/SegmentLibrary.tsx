import React, { useEffect, useState } from 'react';
import type { AudienceApiClient } from './api.js';
import type { SegmentSummary } from './types.js';

export interface SegmentLibraryProps {
  client: AudienceApiClient;
  onSelectSegment: (id: string) => void;
  onCreateNew: () => void;
  onEditSegment?: (id: string) => void;
  canActivate?: boolean;
}

export function SegmentLibrary({ client, onSelectSegment, onCreateNew, onEditSegment, canActivate = true }: SegmentLibraryProps) {
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSegments = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listSegments();
      setSegments(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load segments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSegments();
  }, []);

  const handleActivate = async (id: string) => {
    try {
      await client.activateSegment(id);
      await loadSegments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate segment');
    }
  };

  const handleDisable = async (id: string) => {
    try {
      await client.disableSegment(id);
      await loadSegments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable segment');
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const statusBadgeStyle = (status: string): React.CSSProperties => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 600,
    backgroundColor: status === 'active' ? '#d4edda' : status === 'draft' ? '#fff3cd' : '#f8d7da',
    color: status === 'active' ? '#155724' : status === 'draft' ? '#856404' : '#721c24',
  });

  const buttonStyle: React.CSSProperties = {
    padding: '4px 12px',
    border: '1px solid #ccc',
    borderRadius: '4px',
    background: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    marginRight: '4px',
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: '#0066cc',
    color: '#fff',
    border: '1px solid #0066cc',
  };

  if (loading) {
    return <div style={{ padding: '16px' }}>Loading segments...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: '16px' }}>
        <div style={{ color: '#721c24', marginBottom: '8px' }}>{error}</div>
        <button style={buttonStyle} onClick={() => void loadSegments()}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ padding: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>Segments</h2>
        <button style={primaryButtonStyle} onClick={onCreateNew}>New Segment</button>
      </div>

      {segments.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: '#666' }}>
          No segments yet. Create your first segment to get started.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #dee2e6' }}>
              <th style={{ textAlign: 'left', padding: '8px' }}>Name</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Version</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Last Updated</th>
              <th style={{ textAlign: 'left', padding: '8px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((seg) => (
              <tr key={seg.segment_id} style={{ borderBottom: '1px solid #dee2e6' }}>
                <td style={{ padding: '8px' }}>{seg.name}</td>
                <td style={{ padding: '8px' }}>
                  <span style={statusBadgeStyle(seg.status)}>{seg.status}</span>
                </td>
                <td style={{ padding: '8px' }}>v{seg.current_version}</td>
                <td style={{ padding: '8px' }}>{formatDate(seg.updated_at)}</td>
                <td style={{ padding: '8px' }}>
                  <button style={buttonStyle} onClick={() => onSelectSegment(seg.segment_id)}>Use</button>
                  {seg.status === 'draft' && onEditSegment && (
                    <button style={buttonStyle} onClick={() => onEditSegment(seg.segment_id)}>Edit</button>
                  )}
                  {seg.status === 'draft' && canActivate && (
                    <button style={buttonStyle} onClick={() => void handleActivate(seg.segment_id)}>Activate</button>
                  )}
                  {seg.status === 'active' && (
                    <button style={buttonStyle} onClick={() => void handleDisable(seg.segment_id)}>Disable</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
