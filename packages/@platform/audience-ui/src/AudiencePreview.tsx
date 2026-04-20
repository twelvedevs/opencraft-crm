import React, { useEffect, useState } from 'react';
import type { AudiencePreviewProps } from './types.js';
import { AudienceApiClient } from './api.js';
import { summarizeFilter } from './utils/filter-summary.js';

interface SegmentData {
  segment_id: string;
  name: string;
  status: string;
  filter: unknown | null;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#16a34a',
  draft: '#ca8a04',
  disabled: '#dc2626',
};

export function AudiencePreview({ audienceEngineUrl, segmentId, onFetchEntities }: AudiencePreviewProps) {
  const [segment, setSegment] = useState<SegmentData | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = new AudienceApiClient(audienceEngineUrl);
    let cancelled = false;

    setLoading(true);
    setError(null);
    setCount(null);

    client
      .getSegment(segmentId)
      .then(async (data) => {
        if (cancelled) return;
        setSegment(data);
        if (onFetchEntities && data.filter) {
          try {
            const entities = await onFetchEntities(data.filter);
            if (!cancelled) {
              const result = await client.evaluateInline(data.filter, entities);
              if (!cancelled) setCount(result.matched_count);
            }
          } catch {
            // count unavailable — non-fatal
          }
        }
        if (!cancelled) setLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load segment');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [audienceEngineUrl, segmentId]);

  if (loading) {
    return <div style={{ padding: 16, color: '#6b7280' }}>Loading segment…</div>;
  }

  if (error || !segment) {
    return (
      <div style={{ padding: 16, color: '#dc2626' }}>
        {error || 'Segment not found'}
      </div>
    );
  }

  const conditions = segment.filter ? summarizeFilter(segment.filter) : [];
  const statusColor = STATUS_COLORS[segment.status] ?? '#6b7280';

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>{segment.name}</h3>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            backgroundColor: statusColor,
          }}
        >
          {segment.status}
        </span>
      </div>

      {conditions.length > 0 ? (
        <>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
            {conditions.length} condition{conditions.length !== 1 ? 's' : ''}
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, marginBottom: 12 }}>
            {conditions.map((text, i) => (
              <li key={i} style={{ fontSize: 14, marginBottom: 4 }}>
                {text}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          No filter conditions available
        </div>
      )}

      {count !== null && (
        <div style={{ fontSize: 13, color: '#374151' }}>
          Estimated audience: <strong>{count.toLocaleString()}</strong>
        </div>
      )}
    </div>
  );
}
