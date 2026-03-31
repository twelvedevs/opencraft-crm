import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

export interface StepOutputReadyPayload {
  enrollment_id: string;
  step_id: string;
  entity_type: string;
  entity_id: string;
}

export interface EnrollmentCompletedPayload {
  enrollment_id: string;
  sequence_id: string;
  entity_type: string;
  entity_id: string;
  completed_at: string;
}

export interface StepFailedPayload {
  enrollment_id: string;
  step_id: string;
  entity_type: string;
  entity_id: string;
  error: string;
  attempt: number;
}

export class NurturingPublisher {
  constructor(
    private ebClient: EventBridgeClient,
    private busName: string,
  ) {}

  async publishStepOutputReady(data: StepOutputReadyPayload): Promise<void> {
    await this.ebClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: 'platform.nurturing',
            DetailType: 'nurturing.step_output_ready',
            Detail: JSON.stringify(data),
          },
        ],
      }),
    );
  }

  async publishEnrollmentCompleted(data: EnrollmentCompletedPayload): Promise<void> {
    await this.ebClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: 'platform.nurturing',
            DetailType: 'nurturing.enrollment_completed',
            Detail: JSON.stringify(data),
          },
        ],
      }),
    );
  }

  async publishStepFailed(data: StepFailedPayload): Promise<void> {
    await this.ebClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: 'platform.nurturing',
            DetailType: 'nurturing.step_failed',
            Detail: JSON.stringify(data),
          },
        ],
      }),
    );
  }
}

export function createPublisher(ebClient?: EventBridgeClient): NurturingPublisher {
  const busName = process.env['EVENTBRIDGE_BUS_NAME'];
  if (!busName) {
    throw new Error('Missing required environment variable: EVENTBRIDGE_BUS_NAME');
  }
  return new NurturingPublisher(ebClient ?? new EventBridgeClient({}), busName);
}
