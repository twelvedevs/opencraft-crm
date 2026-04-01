import React, { useEffect, useRef, useState } from 'react';
import type { AudienceApiClient } from './api.js';
import type { FieldDefinition } from './types.js';
import { FilterTree } from './FilterTree.js';
import type { FilterNode } from './FilterTree.js';

export interface SegmentEditorProps {
  client: AudienceApiClient;
  segmentId?: string;
  fields: FieldDefinition[];
  onFetchEntities?: (filter: unknown) => Promise<Record<string, unknown>[]>;
  onSave: (segmentId: string) => void;
  onCancel: () => void;
}

const btnStyle: React.CSSProperties = {
  padding: '6px 16px',
  border: '1px solid #ccc',
  borderRadius: '4px',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '14px',
  marginRight: '8px',
};

const primaryBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: '#0066cc',
  color: '#fff',
  border: '1px solid #0066cc',
};

export function SegmentEditor({
  client,
  segmentId,
  fields,
  onFetchEntities,
  onSave,
  onCancel,
}: SegmentEditorProps) {
  const [name, setName] = useState('');
  const [filter, setFilter] = useState<FilterNode>({ op: 'AND', conditions: [] });
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!segmentId);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!segmentId) return;
    client
      .getSegment(segmentId)
      .then((seg) => {
        setName(seg.name ?? '');
        if (seg.filter) {
          setFilter(seg.filter as FilterNode);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load segment');
        setLoading(false);
      });
  }, [segmentId]);

  const runPreview = (currentFilter: FilterNode) => {
    if (!onFetchEntities) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const entities = await onFetchEntities(currentFilter);
        const result = await client.evaluateInline(currentFilter, entities);
        setPreviewCount(result.matched_count);
        setPreviewError(null);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : 'Preview failed');
        setPreviewCount(null);
      }
    }, 500);
  };

  const handleFilterChange = (updated: FilterNode) => {
    setFilter(updated);
    runPreview(updated);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Segment name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (segmentId) {
        await client.updateSegment(segmentId, filter);
        onSave(segmentId);
      } else {
        const result = await client.createSegment(name, filter);
        onSave(result.segment_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save segment');
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '16px' }}>Loading segment...</div>;
  }

  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>{segmentId ? 'Edit Segment' : 'New Segment'}</h2>

      {error && (
        <div style={{ color: '#721c24', backgroundColor: '#f8d7da', padding: '8px 12px', borderRadius: '4px', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600, fontSize: '14px' }}>
          Segment Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter segment name"
          style={{ padding: '6px 10px', fontSize: '14px', width: '100%', maxWidth: '400px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: '4px' }}
        />
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', marginBottom: '8px', fontWeight: 600, fontSize: '14px' }}>
          Filter Conditions
        </label>
        <FilterTree node={filter} fields={fields} onChange={handleFilterChange} />
      </div>

      {onFetchEntities && (
        <div style={{ marginBottom: '16px', padding: '8px 12px', backgroundColor: '#e8f4fd', borderRadius: '4px', fontSize: '13px' }}>
          {previewError ? (
            <span style={{ color: '#856404' }}>Preview: {previewError}</span>
          ) : previewCount !== null ? (
            <span>Estimated matches: <strong>{previewCount}</strong></span>
          ) : (
            <span style={{ color: '#666' }}>Preview will update as you edit conditions</span>
          )}
        </div>
      )}

      <div>
        <button style={primaryBtnStyle} onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button style={btnStyle} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
