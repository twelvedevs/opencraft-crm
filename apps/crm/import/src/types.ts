export interface Import {
  id: string;
  location_id: string;
  import_type: string;
  status: string;
  uploaded_by: string;
  file_name: string;
  file_key: string;
  column_mapping: Record<string, string> | null;
  detected_headers: string[] | null;
  row_count: number | null;
  matched_count: number | null;
  unmatched_count: number | null;
  ambiguous_count: number | null;
  executed_count: number | null;
  failed_count: number | null;
  error_message: string | null;
  completed_at: Date | null;
  undo_deadline: Date | null;
  undone_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ImportRow {
  id: string;
  import_id: string;
  row_number: number;
  raw_data: Record<string, unknown>;
  matched_lead_id: string | null;
  match_tier: number | null;
  candidate_ids: string[] | null;
  status: string;
  before_snapshot: Record<string, unknown> | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ColumnMapping {
  import_type: string;
  mapping: Record<string, string>;
  updated_at: Date;
  updated_by: string;
}
