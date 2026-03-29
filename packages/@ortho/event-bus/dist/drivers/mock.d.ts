import type { Driver, EventHandler, OrthoEvent } from '../types.js';
export declare class MockDriver implements Driver {
    readonly published: OrthoEvent[];
    publish(event: OrthoEvent): Promise<void>;
    start(_subscriptions: Map<string, EventHandler[]>): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=mock.d.ts.map