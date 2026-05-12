/**
 * Maps known Ortho2 CSV headers to CRM field names.
 */
export const ORTHO2_HEADERS: Record<string, string> = {
  PatFirst: 'first_name',
  PatLast: 'last_name',
  CellPhone: 'mobile_phone',
  HomePhone: 'home_phone',
  Email: 'email',
  Birthdate: 'date_of_birth',
  ApptDate: 'appointment_date',
  ApptTime: 'appointment_time',
  Status: 'ortho2_status',
};

/**
 * Given an array of raw CSV headers, returns a mapping of CRM field → CSV header
 * for only the recognized Ortho2 headers.
 */
export function autoDetectMapping(csvHeaders: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const header of csvHeaders) {
    const crmField = ORTHO2_HEADERS[header];
    if (crmField) {
      mapping[crmField] = header;
    }
  }
  return mapping;
}
