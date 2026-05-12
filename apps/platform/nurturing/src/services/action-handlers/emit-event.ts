import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { interpolateFields } from '@ortho/interpolator';

export interface EmitEventParams {
  event_type: string;
  payload: Record<string, unknown>;
  include_context?: boolean;
}

export interface EmitEventContext {
  enrollment_id: string;
  step_id: string;
  entity_type: string;
  entity_id: string;
  enrollmentContext: Record<string, unknown>;
}

export async function executeEmitEvent(
  params: EmitEventParams,
  ctx: EmitEventContext,
  ebClient: EventBridgeClient,
  busName: string,
): Promise<void> {
  const execContext: Record<string, unknown> = {
    context: ctx.enrollmentContext,
    enrollment_id: ctx.enrollment_id,
    step_id: ctx.step_id,
    entity_type: ctx.entity_type,
    entity_id: ctx.entity_id,
  };

  const resolvedPayload = interpolateFields(params.payload, execContext);

  const finalPayload: Record<string, unknown> =
    params.include_context === true
      ? { ...ctx.enrollmentContext, ...resolvedPayload }
      : resolvedPayload;

  await ebClient.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: 'platform.nurturing',
          DetailType: params.event_type,
          Detail: JSON.stringify(finalPayload),
        },
      ],
    }),
  );
}
