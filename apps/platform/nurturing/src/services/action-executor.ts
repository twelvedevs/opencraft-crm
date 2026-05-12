import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { interpolateFields } from '@ortho/interpolator';
import type { ServiceUrls } from '../config/service-urls.js';
import { executeSendMessage } from './action-handlers/send-message.js';
import { executeSendEmail } from './action-handlers/send-email.js';
import { executeCallAi } from './action-handlers/call-ai.js';
import { executeEmitEvent } from './action-handlers/emit-event.js';

export interface ActionExecutorDeps {
  urls: ServiceUrls;
  ebClient: EventBridgeClient;
  busName: string;
}

export interface StepDef {
  id: string;
  action: {
    type: string;
    params: Record<string, unknown>;
  };
  ab_variant_override?: Record<string, Record<string, unknown>>;
}

export interface ExecutionContext {
  enrollment_id: string;
  step_id: string;
  entity_type: string;
  entity_id: string;
  enrollmentContext: Record<string, unknown>;
  abVariant: string | null;
}

export interface ActionResult {
  output?: unknown;
  chainSendMessage?: {
    to: string;
    from: string;
    body: string;
    dedup_key: string;
  };
}

export async function executeAction(
  stepDef: StepDef,
  execCtx: ExecutionContext,
  deps: ActionExecutorDeps,
): Promise<ActionResult> {
  const interpolationContext: Record<string, unknown> = {
    context: execCtx.enrollmentContext,
    enrollment_id: execCtx.enrollment_id,
    step_id: execCtx.step_id,
    entity_type: execCtx.entity_type,
    entity_id: execCtx.entity_id,
  };

  let resolvedParams = interpolateFields(stepDef.action.params, interpolationContext);

  if (stepDef.ab_variant_override !== undefined && execCtx.abVariant !== null) {
    const overrides = stepDef.ab_variant_override[execCtx.abVariant] ?? {};
    const resolvedOverrides = interpolateFields(overrides, interpolationContext);
    resolvedParams = { ...resolvedParams, ...resolvedOverrides };
  }

  switch (stepDef.action.type) {
    case 'send_message':
      await executeSendMessage(
        {
          template_id: resolvedParams['template_id'] as string,
          to: resolvedParams['to_field'] as string,
          from: resolvedParams['from_field'] as string,
          dedup_key: resolvedParams['dedup_key'] as string,
          context: execCtx.enrollmentContext,
        },
        deps.urls.templateServiceUrl,
        deps.urls.messagingServiceUrl,
      );
      return {};

    case 'send_email':
      await executeSendEmail(
        {
          template_id: resolvedParams['template_id'] as string,
          to: resolvedParams['to_field'] as string,
          from: resolvedParams['from_field'] as string,
          dedup_key: resolvedParams['dedup_key'] as string,
          context: execCtx.enrollmentContext,
        },
        deps.urls.templateServiceUrl,
        deps.urls.emailServiceUrl,
      );
      return {};

    case 'call_ai': {
      const result = await executeCallAi(
        {
          system_prompt: resolvedParams['system_prompt'] as string,
          user_prompt: resolvedParams['user_prompt'] as string,
          model: resolvedParams['model'] as string,
          auto_send: resolvedParams['auto_send'] as boolean | undefined,
        },
        deps.urls.aiServiceUrl,
      );
      if (
        result.auto_send === true &&
        resolvedParams['to_field'] !== undefined &&
        resolvedParams['from_field'] !== undefined &&
        resolvedParams['dedup_key'] !== undefined
      ) {
        return {
          output: result.output,
          chainSendMessage: {
            to: resolvedParams['to_field'] as string,
            from: resolvedParams['from_field'] as string,
            body: result.output,
            dedup_key: resolvedParams['dedup_key'] as string,
          },
        };
      }
      return { output: result.output };
    }

    case 'emit_event':
      await executeEmitEvent(
        {
          event_type: resolvedParams['event_type'] as string,
          payload: resolvedParams['payload'] as Record<string, unknown>,
          include_context: resolvedParams['include_context'] as boolean | undefined,
        },
        {
          enrollment_id: execCtx.enrollment_id,
          step_id: execCtx.step_id,
          entity_type: execCtx.entity_type,
          entity_id: execCtx.entity_id,
          enrollmentContext: execCtx.enrollmentContext,
        },
        deps.ebClient,
        deps.busName,
      );
      return {};

    default:
      throw new Error(`Unknown action type: ${stepDef.action.type}`);
  }
}
