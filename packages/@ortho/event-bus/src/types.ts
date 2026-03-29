export interface OrthoEvent {
  event_type: string;
  entity_type?: string;
  entity_id?: string;
  payload: Record<string, unknown>;
  correlation_id?: string;
  causation_id?: string;
  schema_version?: string;
}

export type EventHandler = (event: OrthoEvent) => Promise<void>;

export interface EventBus {
  publish(event: OrthoEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Driver {
  publish(event: OrthoEvent): Promise<void>;
  start(subscriptions: Map<string, EventHandler[]>): Promise<void>;
  stop(): Promise<void>;
}
