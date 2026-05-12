import React from 'react';
import type { FieldDefinition } from './types.js';

// Local filter node types (mirror @platform/filter-engine types to avoid cross-package import issues)
export interface ConditionNode {
  field: string;
  op: string;
  value?: unknown;
}

export interface GroupNode {
  op: 'AND' | 'OR';
  conditions: FilterNode[];
}

export interface NotNode {
  op: 'NOT';
  condition: FilterNode;
}

export type FilterNode = ConditionNode | GroupNode | NotNode;

function isGroup(node: FilterNode): node is GroupNode {
  return node.op === 'AND' || node.op === 'OR';
}

function isNot(node: FilterNode): node is NotNode {
  return node.op === 'NOT';
}

const OPERATORS_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  string: [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'in', label: 'in' },
    { value: 'not_in', label: 'not in' },
    { value: 'contains', label: 'contains' },
    { value: 'exists', label: 'exists' },
    { value: 'not_exists', label: 'not exists' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '>=' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '<=' },
    { value: 'exists', label: 'exists' },
    { value: 'not_exists', label: 'not exists' },
  ],
  boolean: [
    { value: 'eq', label: '=' },
    { value: 'not_exists', label: 'not exists' },
  ],
  timestamp: [
    { value: 'eq', label: '=' },
    { value: 'before', label: 'before' },
    { value: 'after', label: 'after' },
    { value: 'within_last', label: 'within last' },
    { value: 'not_within_last', label: 'not within last' },
    { value: 'date_range', label: 'date range' },
  ],
  array: [
    { value: 'contains', label: 'contains' },
    { value: 'exists', label: 'exists' },
    { value: 'not_exists', label: 'not exists' },
  ],
};

const NO_VALUE_OPS = new Set(['exists', 'not_exists']);

export interface FilterTreeProps {
  node: FilterNode;
  fields: FieldDefinition[];
  onChange: (node: FilterNode) => void;
  onRemove?: () => void;
}

const nodeStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: '4px',
  padding: '8px',
  marginBottom: '8px',
  backgroundColor: '#fafafa',
};

const smallBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  border: '1px solid #ccc',
  borderRadius: '3px',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '12px',
  marginRight: '4px',
};

const removeBtnStyle: React.CSSProperties = {
  ...smallBtnStyle,
  color: '#dc3545',
  borderColor: '#dc3545',
};

function getFieldType(field: string, fields: FieldDefinition[]): string {
  const def = fields.find((f) => f.key === field);
  return def?.type ?? 'string';
}

function getOperators(fieldType: string): { value: string; label: string }[] {
  return OPERATORS_BY_TYPE[fieldType] ?? OPERATORS_BY_TYPE['string']!;
}

function ConditionEditor({
  node,
  fields,
  onChange,
  onRemove,
}: {
  node: ConditionNode;
  fields: FieldDefinition[];
  onChange: (node: FilterNode) => void;
  onRemove?: () => void;
}) {
  const fieldType = getFieldType(node.field, fields);
  const operators = getOperators(fieldType);
  const showValue = !NO_VALUE_OPS.has(node.op);

  const handleFieldChange = (newField: string) => {
    const newType = getFieldType(newField, fields);
    const newOps = getOperators(newType);
    const opValid = newOps.some((o) => o.value === node.op);
    onChange({
      field: newField,
      op: opValid ? node.op : newOps[0]!.value,
      value: undefined,
    } as ConditionNode);
  };

  const handleOpChange = (newOp: string) => {
    const updated: ConditionNode = { field: node.field, op: newOp };
    if (!NO_VALUE_OPS.has(newOp)) {
      if (newOp === 'within_last' || newOp === 'not_within_last') {
        updated.value = { amount: 7, unit: 'days' };
      } else if (newOp === 'date_range') {
        updated.value = { start: '', end: '' };
      } else {
        updated.value = node.value;
      }
    }
    onChange(updated);
  };

  return (
    <div style={{ ...nodeStyle, display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <select
        value={node.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        style={{ padding: '4px', fontSize: '13px' }}
      >
        <option value="">-- field --</option>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>

      <select
        value={node.op}
        onChange={(e) => handleOpChange(e.target.value)}
        style={{ padding: '4px', fontSize: '13px' }}
      >
        {operators.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {showValue && <ValueInput node={node} fieldType={fieldType} onChange={onChange} />}

      {onRemove && (
        <button style={removeBtnStyle} onClick={onRemove} title="Remove condition">
          &times;
        </button>
      )}
    </div>
  );
}

function ValueInput({
  node,
  fieldType,
  onChange,
}: {
  node: ConditionNode;
  fieldType: string;
  onChange: (node: FilterNode) => void;
}) {
  const op = node.op;

  if (op === 'within_last' || op === 'not_within_last') {
    const val = (node.value ?? { amount: 7, unit: 'days' }) as { amount: number; unit: string };
    return (
      <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <input
          type="number"
          value={val.amount}
          min={1}
          onChange={(e) => onChange({ ...node, value: { ...val, amount: Number(e.target.value) } })}
          style={{ width: '60px', padding: '4px', fontSize: '13px' }}
        />
        <select
          value={val.unit}
          onChange={(e) => onChange({ ...node, value: { ...val, unit: e.target.value } })}
          style={{ padding: '4px', fontSize: '13px' }}
        >
          <option value="days">days</option>
          <option value="hours">hours</option>
        </select>
      </span>
    );
  }

  if (op === 'date_range') {
    const val = (node.value ?? { start: '', end: '' }) as { start: string; end: string };
    return (
      <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <input
          type="date"
          value={val.start}
          onChange={(e) => onChange({ ...node, value: { ...val, start: e.target.value } })}
          style={{ padding: '4px', fontSize: '13px' }}
        />
        <span>to</span>
        <input
          type="date"
          value={val.end}
          onChange={(e) => onChange({ ...node, value: { ...val, end: e.target.value } })}
          style={{ padding: '4px', fontSize: '13px' }}
        />
      </span>
    );
  }

  if (op === 'before' || op === 'after') {
    return (
      <input
        type="date"
        value={(node.value as string) ?? ''}
        onChange={(e) => onChange({ ...node, value: e.target.value })}
        style={{ padding: '4px', fontSize: '13px' }}
      />
    );
  }

  if (fieldType === 'boolean') {
    return (
      <select
        value={String(node.value ?? 'true')}
        onChange={(e) => onChange({ ...node, value: e.target.value === 'true' })}
        style={{ padding: '4px', fontSize: '13px' }}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (op === 'in' || op === 'not_in') {
    const arr = Array.isArray(node.value) ? node.value : [];
    return (
      <input
        type="text"
        value={arr.join(', ')}
        placeholder="comma-separated values"
        onChange={(e) => onChange({ ...node, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
        style={{ padding: '4px', fontSize: '13px', minWidth: '150px' }}
      />
    );
  }

  return (
    <input
      type={fieldType === 'number' ? 'number' : 'text'}
      value={node.value != null ? String(node.value) : ''}
      placeholder="value"
      onChange={(e) => {
        const v = fieldType === 'number' ? Number(e.target.value) : e.target.value;
        onChange({ ...node, value: v });
      }}
      style={{ padding: '4px', fontSize: '13px', minWidth: '120px' }}
    />
  );
}

function GroupEditor({
  node,
  fields,
  onChange,
  onRemove,
}: {
  node: GroupNode;
  fields: FieldDefinition[];
  onChange: (node: FilterNode) => void;
  onRemove?: () => void;
}) {
  const toggleOp = () => {
    onChange({ ...node, op: node.op === 'AND' ? 'OR' : 'AND' });
  };

  const updateChild = (index: number, child: FilterNode) => {
    const updated = [...node.conditions];
    updated[index] = child;
    onChange({ ...node, conditions: updated });
  };

  const removeChild = (index: number) => {
    const updated = node.conditions.filter((_, i) => i !== index);
    onChange({ ...node, conditions: updated });
  };

  const addCondition = () => {
    const firstField = fields[0]?.key ?? '';
    const fieldType = getFieldType(firstField, fields);
    const defaultOp = getOperators(fieldType)[0]?.value ?? 'eq';
    onChange({
      ...node,
      conditions: [...node.conditions, { field: firstField, op: defaultOp } as ConditionNode],
    });
  };

  const addGroup = () => {
    onChange({
      ...node,
      conditions: [...node.conditions, { op: 'AND', conditions: [] } as GroupNode],
    });
  };

  return (
    <div style={{ ...nodeStyle, borderLeft: '3px solid #0066cc', backgroundColor: '#f8f9fa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <button style={smallBtnStyle} onClick={toggleOp}>
          {node.op}
        </button>
        <span style={{ fontSize: '12px', color: '#666' }}>
          Match {node.op === 'AND' ? 'all' : 'any'} of the following:
        </span>
        <span style={{ flex: 1 }} />
        {onRemove && (
          <button style={removeBtnStyle} onClick={onRemove} title="Remove group">
            &times;
          </button>
        )}
      </div>

      {node.conditions.map((child, i) => (
        <FilterTree
          key={i}
          node={child}
          fields={fields}
          onChange={(updated) => updateChild(i, updated)}
          onRemove={() => removeChild(i)}
        />
      ))}

      <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
        <button style={smallBtnStyle} onClick={addCondition}>+ Condition</button>
        <button style={smallBtnStyle} onClick={addGroup}>+ Group</button>
      </div>
    </div>
  );
}

function NotEditor({
  node,
  fields,
  onChange,
  onRemove,
}: {
  node: NotNode;
  fields: FieldDefinition[];
  onChange: (node: FilterNode) => void;
  onRemove?: () => void;
}) {
  return (
    <div style={{ ...nodeStyle, borderLeft: '3px solid #dc3545', backgroundColor: '#fff5f5' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#dc3545' }}>NOT</span>
        <span style={{ flex: 1 }} />
        {onRemove && (
          <button style={removeBtnStyle} onClick={onRemove} title="Remove NOT">
            &times;
          </button>
        )}
      </div>
      <FilterTree
        node={node.condition}
        fields={fields}
        onChange={(updated) => onChange({ op: 'NOT', condition: updated })}
      />
    </div>
  );
}

export function FilterTree({ node, fields, onChange, onRemove }: FilterTreeProps) {
  if (isGroup(node)) {
    return <GroupEditor node={node} fields={fields} onChange={onChange} onRemove={onRemove} />;
  }
  if (isNot(node)) {
    return <NotEditor node={node} fields={fields} onChange={onChange} onRemove={onRemove} />;
  }
  return <ConditionEditor node={node as ConditionNode} fields={fields} onChange={onChange} onRemove={onRemove} />;
}
