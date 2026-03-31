import type { SequenceDefinition, SequenceDefinitionsRepository } from '../repositories/sequence-definitions.repo.js';
import type { SequenceVersion, SequenceVersionsRepository } from '../repositories/sequence-versions.repo.js';

export interface SaveDraftInput {
  active_hours?: unknown;
  cancel_on_opt_out?: boolean;
  steps: unknown[];
  ab_test?: unknown;
}

export class VersioningService {
  constructor(
    private readonly definitionsRepo: SequenceDefinitionsRepository,
    private readonly versionsRepo: SequenceVersionsRepository,
  ) {}

  async saveDraft(
    sequenceId: string,
    input: SaveDraftInput,
    createdBy?: string,
  ): Promise<{ definition: SequenceDefinition; version: SequenceVersion }> {
    const definition = await this.definitionsRepo.findById(sequenceId);
    if (!definition) {
      throw new Error('sequence_not_found');
    }

    const newVersion = definition.current_version + 1;

    const version = await this.versionsRepo.insert({
      sequence_id: sequenceId,
      version: newVersion,
      active_hours: input.active_hours,
      cancel_on_opt_out: input.cancel_on_opt_out ?? true,
      steps: input.steps,
      ab_test: input.ab_test,
      created_by: createdBy,
    });

    const updatedDefinition = await this.definitionsRepo.updateCurrentVersion(sequenceId, newVersion);

    return { definition: updatedDefinition!, version };
  }
}
