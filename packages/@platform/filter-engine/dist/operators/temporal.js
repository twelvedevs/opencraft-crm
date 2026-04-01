function resolveField(entity, path) {
    const parts = path.split('.');
    let current = entity;
    for (const part of parts) {
        if (current === null || current === undefined)
            return undefined;
        current = current[part];
    }
    return current;
}
function toDate(val) {
    if (val instanceof Date)
        return val;
    if (typeof val === 'string') {
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}
export function evaluateTemporal(node, entity, context) {
    const fieldValue = resolveField(entity, node.field);
    if (fieldValue === undefined || fieldValue === null)
        return false;
    const fieldDate = toDate(fieldValue);
    if (!fieldDate)
        return false;
    switch (node.op) {
        case 'within_last': {
            const { amount, unit } = node.value;
            const multiplier = unit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
            const threshold = context.now.getTime() - amount * multiplier;
            return fieldDate.getTime() >= threshold;
        }
        case 'not_within_last': {
            const { amount, unit } = node.value;
            const multiplier = unit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
            const threshold = context.now.getTime() - amount * multiplier;
            return fieldDate.getTime() < threshold;
        }
        case 'before':
            return fieldDate.getTime() < new Date(node.value).getTime();
        case 'after':
            return fieldDate.getTime() > new Date(node.value).getTime();
        case 'date_range': {
            const { start, end } = node.value;
            return fieldDate.getTime() >= new Date(start).getTime() &&
                fieldDate.getTime() <= new Date(end).getTime();
        }
        default:
            throw new Error(`Unknown temporal operator: ${node.op}`);
    }
}
//# sourceMappingURL=temporal.js.map