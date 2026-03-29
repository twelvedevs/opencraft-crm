import type { Driver, EventHandler, OrthoEvent } from '../types.js';
export interface RedisStreamsOptions {
    redisUrl: string;
    consumerGroup: string;
}
export declare class RedisStreamsDriver implements Driver {
    private readonly redis;
    private readonly consumerGroup;
    private readonly consumerId;
    private shouldStop;
    private loopPromises;
    constructor(options: RedisStreamsOptions);
    publish(event: OrthoEvent): Promise<void>;
    start(subscriptions: Map<string, EventHandler[]>): Promise<void>;
    private readLoop;
    private eventToFields;
    private fieldsToEvent;
    stop(): Promise<void>;
}
//# sourceMappingURL=redis-streams.d.ts.map