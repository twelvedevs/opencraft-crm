import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UndoService } from '../../src/services/undo.service.js';
import type { PipelineEngineClient } from '../../src/clients/pipeline-engine.js';
import type { LeadServiceClient } from '../../src/clients/lead-service.js';
import type { ImportRow, Import } from '../../src/types.js';

function mockPipelineClient() {
  return {
    createTransition: vi.fn().mockResolvedValue({}),
    closeMembership: vi.fn().mockResolvedValue({}),
    enrollMembership: vi.fn().mockResolvedValue({}),
    getMemberships: vi.fn(),
    convertMembership: vi.fn(),
  } as unknown as PipelineEngineClient;
}

function mockLeadClient() {
  return {
    deleteAppointment: vi.fn().mockResolvedValue(undefined),
    searchLeads: vi.fn(),
    createAppointment: vi.fn(),
  } as unknown as LeadServiceClient;
}

function makeImportRow(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    id: crypto.randomUUID(),
    import_id: crypto.randomUUID(),
    row_number: 1,
    raw_data: {},
    matched_lead_id: crypto.randomUUID(),
    match_tier: 1,
    candidate_ids: null,
    status: 'executed',
    before_snapshot: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeImport(overrides: Partial<Import> = {}): Import {
  return {
    id: crypto.randomUUID(),
    location_id: crypto.randomUUID(),
    import_type: 'active_patients',
    status: 'completed',
    uploaded_by: crypto.randomUUID(),
    file_name: 'test.csv',
    file_key: 'imports/test/raw.csv',
    column_mapping: null,
    detected_headers: null,
    row_count: null,
    matched_count: null,
    unmatched_count: null,
    ambiguous_count: null,
    executed_count: null,
    failed_count: null,
    error_message: null,
    completed_at: null,
    undo_deadline: null,
    undone_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('UndoService', () => {
  let pipelineClient: PipelineEngineClient;
  let leadClient: LeadServiceClient;
  let service: UndoService;
  let importRecord: Import;

  beforeEach(() => {
    pipelineClient = mockPipelineClient();
    leadClient = mockLeadClient();
    service = new UndoService(pipelineClient, leadClient);
    importRecord = makeImport();
  });

  describe('transition snapshot', () => {
    it('calls createTransition with stage, override:true, reason:import_undo', async () => {
      const membershipId = crypto.randomUUID();
      const row = makeImportRow({
        before_snapshot: {
          type: 'transition',
          membership_id: membershipId,
          stage: 'exam_scheduled',
          appointment_id: null,
        },
      });

      await service.undoRow(row, importRecord);

      expect(vi.mocked(pipelineClient.createTransition)).toHaveBeenCalledWith(
        membershipId,
        {
          stage: 'exam_scheduled',
          override: true,
          triggered_by: importRecord.uploaded_by,
          reason: 'import_undo',
        },
      );
    });

    it('does NOT call deleteAppointment when appointment_id is null', async () => {
      const row = makeImportRow({
        before_snapshot: {
          type: 'transition',
          membership_id: crypto.randomUUID(),
          stage: 'contacted',
          appointment_id: null,
        },
      });

      await service.undoRow(row, importRecord);

      expect(vi.mocked(leadClient.deleteAppointment)).not.toHaveBeenCalled();
    });

    it('calls deleteAppointment when appointment_id is non-null', async () => {
      const appointmentId = crypto.randomUUID();
      const leadId = crypto.randomUUID();
      const row = makeImportRow({
        matched_lead_id: leadId,
        before_snapshot: {
          type: 'transition',
          membership_id: crypto.randomUUID(),
          stage: 'exam_scheduled',
          appointment_id: appointmentId,
        },
      });

      await service.undoRow(row, importRecord);

      expect(vi.mocked(leadClient.deleteAppointment)).toHaveBeenCalledWith(
        leadId,
        appointmentId,
      );
    });
  });

  describe('conversion snapshot', () => {
    it('calls closeMembership first with post_import_membership_id', async () => {
      const postMembershipId = crypto.randomUUID();
      const row = makeImportRow({
        before_snapshot: {
          type: 'conversion',
          post_import_membership_id: postMembershipId,
          pre_import_membership_id: crypto.randomUUID(),
          pre_import_pipeline: 'new_patient',
          pre_import_stage: 'contract_signed',
        },
      });

      await service.undoRow(row, importRecord);

      expect(vi.mocked(pipelineClient.closeMembership)).toHaveBeenCalledWith(
        postMembershipId,
        {
          triggered_by: importRecord.uploaded_by,
          reason: 'import_undo',
        },
      );
    });

    it('calls enrollMembership second with pre_import_pipeline and pre_import_stage, lead_id from row.matched_lead_id', async () => {
      const matchedLeadId = crypto.randomUUID();
      const row = makeImportRow({
        matched_lead_id: matchedLeadId,
        before_snapshot: {
          type: 'conversion',
          post_import_membership_id: crypto.randomUUID(),
          pre_import_membership_id: crypto.randomUUID(),
          pre_import_pipeline: 'new_patient',
          pre_import_stage: 'contract_signed',
        },
      });

      await service.undoRow(row, importRecord);

      expect(vi.mocked(pipelineClient.enrollMembership)).toHaveBeenCalledWith({
        lead_id: matchedLeadId,
        location_id: importRecord.location_id,
        pipeline: 'new_patient',
        stage: 'contract_signed',
        triggered_by: importRecord.uploaded_by,
        reason: 'import_undo',
      });
    });

    it('closeMembership is called before enrollMembership', async () => {
      const row = makeImportRow({
        before_snapshot: {
          type: 'conversion',
          post_import_membership_id: crypto.randomUUID(),
          pre_import_membership_id: crypto.randomUUID(),
          pre_import_pipeline: 'new_patient',
          pre_import_stage: 'exam_completed',
        },
      });

      await service.undoRow(row, importRecord);

      const closeOrder = vi.mocked(pipelineClient.closeMembership).mock.invocationCallOrder[0];
      const enrollOrder = vi.mocked(pipelineClient.enrollMembership).mock.invocationCallOrder[0];
      expect(closeOrder).toBeLessThan(enrollOrder);
    });

    it('uses importRecord.location_id for enrollMembership (not snapshot)', async () => {
      const specificLocationId = 'location-from-import-record';
      const importRec = makeImport({ location_id: specificLocationId });
      const row = makeImportRow({
        before_snapshot: {
          type: 'conversion',
          post_import_membership_id: crypto.randomUUID(),
          pre_import_membership_id: crypto.randomUUID(),
          pre_import_pipeline: 'new_patient',
          pre_import_stage: 'exam_completed',
          location_id: 'snapshot-location-should-not-be-used',
        },
      });

      await service.undoRow(row, importRec);

      expect(vi.mocked(pipelineClient.enrollMembership)).toHaveBeenCalledWith(
        expect.objectContaining({
          location_id: specificLocationId,
        }),
      );
    });
  });

  describe('unknown snapshot type', () => {
    it('throws Error', async () => {
      const row = makeImportRow({
        before_snapshot: { type: 'unknown_type' },
      });

      await expect(service.undoRow(row, importRecord)).rejects.toThrow(
        'Unknown snapshot type: unknown_type',
      );
    });
  });

  describe('null snapshot', () => {
    it('throws Error when before_snapshot is null', async () => {
      const row = makeImportRow({ before_snapshot: null });

      await expect(service.undoRow(row, importRecord)).rejects.toThrow(
        'before_snapshot is null',
      );
    });
  });
});
