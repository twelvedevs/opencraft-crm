export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string | null;
  total?: number;
}

/** Exception: GET /imports/:id/rows uses integer row_number as cursor */
export interface RowPaginatedResponse<T> {
  data: T[];
  nextCursor: number | null;
}
