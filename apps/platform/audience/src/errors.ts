export function jsonApiError(
  status: number,
  code: string,
  title: string,
  detail?: string,
) {
  return {
    errors: [
      {
        status: String(status),
        code,
        title,
        ...(detail !== undefined ? { detail } : {}),
      },
    ],
  };
}
