import { Type, type TSchema } from '@sinclair/typebox';

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

/**
 * TypeBox schema helper for paginated responses.
 * Use with Fastify route validation: `reply: PaginatedResponseSchema(itemSchema)`
 */
export const PaginatedResponseSchema = <T extends TSchema>(itemSchema: T) =>
  Type.Object({
    data: Type.Array(itemSchema),
    nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    total: Type.Optional(Type.Number()),
  });
