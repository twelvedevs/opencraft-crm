export type SegmentStatus = 'draft' | 'active' | 'disabled';

export interface SegmentSummary {
  segment_id: string;
  name: string;
  status: SegmentStatus;
  active_version: number | null;
  current_version: number;
  updated_at: string;
}

export interface FieldDefinition {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp' | 'array';
}

export interface SegmentBuilderProps {
  audienceEngineUrl: string;
  fields: FieldDefinition[];
  onSelect?: (segmentId: string) => void;
  onFetchEntities?: (filter: unknown) => Promise<Record<string, unknown>[]>;
  canActivate?: boolean;
}

export interface AudiencePreviewProps {
  audienceEngineUrl: string;
  segmentId: string;
  onFetchEntities?: (filter: unknown) => Promise<Record<string, unknown>[]>;
}
