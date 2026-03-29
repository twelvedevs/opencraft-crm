import { Redis } from 'ioredis';
import { hostname } from 'os';
export class RedisStreamsDriver {
    redis;
    consumerGroup;
    consumerId;
    shouldStop = false;
    loopPromises = [];
    constructor(options) {
        this.redis = new Redis(options.redisUrl, { lazyConnect: true });
        this.consumerGroup = options.consumerGroup;
        this.consumerId = `${options.consumerGroup}-${hostname()}-${process.pid}`;
    }
    async publish(event) {
        const fields = this.eventToFields(event);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.redis.xadd(`stream:${event.event_type}`, 'MAXLEN', '~', '10000', '*', ...fields);
    }
    async start(subscriptions) {
        this.shouldStop = false;
        this.loopPromises = [];
        for (const [eventType, handlers] of subscriptions) {
            const streamName = `stream:${eventType}`;
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await this.redis.xgroup('CREATE', streamName, this.consumerGroup, '$', 'MKSTREAM');
            }
            catch (err) {
                if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) {
                    throw err;
                }
            }
            this.loopPromises.push(this.readLoop(streamName, eventType, handlers));
        }
    }
    async readLoop(streamName, eventType, handlers) {
        while (!this.shouldStop) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const results = await this.redis.xreadgroup('GROUP', this.consumerGroup, this.consumerId, 'COUNT', '10', 'BLOCK', '2000', 'STREAMS', streamName, '>');
            if (!results || results.length === 0) {
                // Yield to the macrotask queue so stop signals can fire.
                await new Promise((r) => setTimeout(r, 0));
                continue;
            }
            for (const [, messages] of results) {
                for (const [messageId, fields] of messages) {
                    const event = this.fieldsToEvent(fields);
                    let failed = false;
                    for (const handler of handlers) {
                        try {
                            await handler(event);
                        }
                        catch {
                            failed = true;
                        }
                    }
                    if (!failed) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        await this.redis.xack(streamName, this.consumerGroup, messageId);
                    }
                    else {
                        // Check delivery count — route to DLQ after 3 attempts
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const pending = await this.redis.xpending(streamName, this.consumerGroup, messageId, messageId, 1);
                        if (pending.length > 0 && pending[0][3] >= 3) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            await this.redis.xadd('stream:dlq', '*', ...this.eventToFields(event));
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            await this.redis.xack(streamName, this.consumerGroup, messageId);
                        }
                    }
                }
            }
            // Consumer-lag check: warn if total pending exceeds 1000
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const summary = await this.redis.xpending(streamName, this.consumerGroup);
            const pendingCount = Array.isArray(summary) ? summary[0] : 0;
            if (pendingCount > 1000) {
                console.warn(`[event-bus] Consumer lag warning: ${pendingCount} pending messages on ${streamName} for group ${this.consumerGroup}`);
            }
        }
    }
    eventToFields(event) {
        const fields = ['event_type', event.event_type];
        if (event.entity_type !== undefined)
            fields.push('entity_type', event.entity_type);
        if (event.entity_id !== undefined)
            fields.push('entity_id', event.entity_id);
        fields.push('payload', JSON.stringify(event.payload));
        if (event.correlation_id !== undefined)
            fields.push('correlation_id', event.correlation_id);
        if (event.causation_id !== undefined)
            fields.push('causation_id', event.causation_id);
        if (event.schema_version !== undefined)
            fields.push('schema_version', event.schema_version);
        return fields;
    }
    fieldsToEvent(fields) {
        const obj = {};
        for (let i = 0; i < fields.length; i += 2) {
            const key = fields[i];
            const val = fields[i + 1];
            if (key !== undefined && val !== undefined)
                obj[key] = val;
        }
        return {
            event_type: obj['event_type'] ?? '',
            entity_type: obj['entity_type'],
            entity_id: obj['entity_id'],
            payload: JSON.parse(obj['payload'] ?? '{}'),
            correlation_id: obj['correlation_id'],
            causation_id: obj['causation_id'],
            schema_version: obj['schema_version'],
        };
    }
    async stop() {
        this.shouldStop = true;
        // Wait up to 3s for all read loops to exit
        await Promise.race([
            Promise.all(this.loopPromises),
            new Promise((r) => setTimeout(r, 3000)),
        ]);
        await this.redis.quit();
    }
}
//# sourceMappingURL=redis-streams.js.map