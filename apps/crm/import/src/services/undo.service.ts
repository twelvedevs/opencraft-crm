import type { PipelineEngineClient } from '../clients/pipeline-engine.js';
import type { LeadServiceClient } from '../clients/lead-service.js';
import type { ImportRow, Import } from '../types.js';

export class UndoService {
  private readonly pipelineEngineClient: PipelineEngineClient;
  private readonly leadServiceClient: LeadServiceClient;

  constructor(pipelineEngineClient: PipelineEngineClient, leadServiceClient: LeadServiceClient) {
    this.pipelineEngineClient = pipelineEngineClient;
    this.leadServiceClient = leadServiceClient;
  }

  async undoRow(row: ImportRow, importRecord: Import): Promise<void> {
    const snapshot = row.before_snapshot as Record<string, unknown> | null;
    if (!snapshot) {
      throw new Error('before_snapshot is null');
    }

    const triggeredBy = importRecord.uploaded_by;

    if (snapshot.type === 'transition') {
      await this.undoTransition(snapshot, triggeredBy, row.matched_lead_id!);
    } else if (snapshot.type === 'conversion') {
      await this.undoConversion(snapshot, importRecord, triggeredBy, row.matched_lead_id!);
    } else {
      throw new Error(`Unknown snapshot type: ${snapshot.type as string}`);
    }
  }

  private async undoTransition(
    snapshot: Record<string, unknown>,
    triggeredBy: string,
    matchedLeadId: string,
  ): Promise<void> {
    await this.pipelineEngineClient.createTransition(
      snapshot.membership_id as string,
      {
        stage: snapshot.stage as string,
        override: true,
        triggered_by: triggeredBy,
        reason: 'import_undo',
      },
    );

    if (snapshot.appointment_id != null) {
      await this.leadServiceClient.deleteAppointment(
        matchedLeadId,
        snapshot.appointment_id as string,
      );
    }
  }

  private async undoConversion(
    snapshot: Record<string, unknown>,
    importRecord: Import,
    triggeredBy: string,
    leadId: string,
  ): Promise<void> {
    await this.pipelineEngineClient.closeMembership(
      snapshot.post_import_membership_id as string,
      {
        triggered_by: triggeredBy,
        reason: 'import_undo',
      },
    );

    await this.pipelineEngineClient.enrollMembership({
      lead_id: leadId,
      location_id: importRecord.location_id,
      pipeline: snapshot.pre_import_pipeline as string,
      stage: snapshot.pre_import_stage as string,
      triggered_by: triggeredBy,
      reason: 'import_undo',
    });
  }
}
