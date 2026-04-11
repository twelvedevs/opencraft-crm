import { describe, it, expect } from 'vitest';
import { ORTHO2_HEADERS, autoDetectMapping } from '../../src/mapping/ortho2-headers.js';

describe('ORTHO2_HEADERS', () => {
  it('maps PatFirst to first_name', () => {
    expect(ORTHO2_HEADERS['PatFirst']).toBe('first_name');
  });

  it('maps PatLast to last_name', () => {
    expect(ORTHO2_HEADERS['PatLast']).toBe('last_name');
  });

  it('maps CellPhone to mobile_phone', () => {
    expect(ORTHO2_HEADERS['CellPhone']).toBe('mobile_phone');
  });

  it('maps HomePhone to home_phone', () => {
    expect(ORTHO2_HEADERS['HomePhone']).toBe('home_phone');
  });

  it('maps Email to email', () => {
    expect(ORTHO2_HEADERS['Email']).toBe('email');
  });

  it('maps Birthdate to date_of_birth', () => {
    expect(ORTHO2_HEADERS['Birthdate']).toBe('date_of_birth');
  });

  it('maps ApptDate to appointment_date', () => {
    expect(ORTHO2_HEADERS['ApptDate']).toBe('appointment_date');
  });

  it('maps ApptTime to appointment_time', () => {
    expect(ORTHO2_HEADERS['ApptTime']).toBe('appointment_time');
  });

  it('maps Status to ortho2_status', () => {
    expect(ORTHO2_HEADERS['Status']).toBe('ortho2_status');
  });

  it('returns undefined for unknown header', () => {
    expect(ORTHO2_HEADERS['Foo']).toBeUndefined();
  });
});

describe('autoDetectMapping', () => {
  it('returns CRM field → CSV header mapping for recognized headers only', () => {
    const result = autoDetectMapping(['PatFirst', 'Foo', 'CellPhone']);
    expect(result).toEqual({
      first_name: 'PatFirst',
      mobile_phone: 'CellPhone',
    });
  });

  it('returns empty object when no headers are recognized', () => {
    const result = autoDetectMapping(['Unknown', 'Columns']);
    expect(result).toEqual({});
  });

  it('maps all 9 known headers', () => {
    const allHeaders = [
      'PatFirst', 'PatLast', 'CellPhone', 'HomePhone',
      'Email', 'Birthdate', 'ApptDate', 'ApptTime', 'Status',
    ];
    const result = autoDetectMapping(allHeaders);
    expect(Object.keys(result)).toHaveLength(9);
    expect(result).toEqual({
      first_name: 'PatFirst',
      last_name: 'PatLast',
      mobile_phone: 'CellPhone',
      home_phone: 'HomePhone',
      email: 'Email',
      date_of_birth: 'Birthdate',
      appointment_date: 'ApptDate',
      appointment_time: 'ApptTime',
      ortho2_status: 'Status',
    });
  });
});
