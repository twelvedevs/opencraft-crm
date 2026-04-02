import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AnthropicInstrumentation } from '@arizeai/openinference-instrumentation-anthropic';

registerInstrumentations({
  instrumentations: [new AnthropicInstrumentation()],
});
