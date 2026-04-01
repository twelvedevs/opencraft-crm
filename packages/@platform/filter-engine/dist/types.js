export function isGroup(node) {
    return node.op === 'AND' || node.op === 'OR';
}
export function isNot(node) {
    return node.op === 'NOT';
}
export function isLeaf(node) {
    return !isGroup(node) && !isNot(node);
}
//# sourceMappingURL=types.js.map