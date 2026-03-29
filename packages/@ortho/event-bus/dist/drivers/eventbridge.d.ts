import type { Driver, EventHandler, OrthoEvent } from '../types.js';
export declare class EventBridgeDriver implements Driver {
    private readonly client;
    private readonly queueUrl;
    private shouldStop;
    private stopResolve;
    private stoppedPromise;
    constructor();
    publish(event: OrthoEvent): Promise<void>;
    start(subscriptions: Map<string, EventHandler[]>): Promise<void>;
    stop(): Promise<void>;
    private pollLoop;
}
//# sourceMappingURL=eventbridge.d.ts.map