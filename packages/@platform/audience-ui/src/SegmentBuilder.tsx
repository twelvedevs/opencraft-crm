import React, { useState } from 'react';
import type { SegmentBuilderProps } from './types.js';
import { AudienceApiClient } from './api.js';
import { SegmentLibrary } from './SegmentLibrary.js';
import { SegmentEditor } from './SegmentEditor.js';

type View = { mode: 'library' } | { mode: 'editor'; segmentId?: string };

export function SegmentBuilder({ audienceEngineUrl, fields, onSelect, onFetchEntities }: SegmentBuilderProps) {
  const [view, setView] = useState<View>({ mode: 'library' });
  const [client] = useState(() => new AudienceApiClient(audienceEngineUrl));

  const goToLibrary = () => setView({ mode: 'library' });

  if (view.mode === 'editor') {
    return (
      <SegmentEditor
        client={client}
        segmentId={view.segmentId}
        fields={fields}
        onFetchEntities={onFetchEntities}
        onSave={(segmentId) => {
          if (onSelect) onSelect(segmentId);
          goToLibrary();
        }}
        onCancel={goToLibrary}
      />
    );
  }

  return (
    <SegmentLibrary
      client={client}
      onSelectSegment={(id) => {
        if (onSelect) onSelect(id);
      }}
      onCreateNew={() => setView({ mode: 'editor' })}
    />
  );
}
