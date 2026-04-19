import React from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { StepDraft } from '../types.js'

interface SortableStepProps {
  step: StepDraft
  index: number
  isSelected: boolean
  onClick: () => void
}

function SortableStep({ step, index, isSelected, onClick }: SortableStepProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    background: '#fff',
    border: `${isSelected ? 2 : 1}px solid ${isSelected ? '#0066cc' : '#dee2e6'}`,
    borderRadius: 6,
    padding: '10px 10px 10px 6px',
    marginBottom: 6,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    cursor: 'pointer',
    userSelect: 'none',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`sq-step-item${isSelected ? ' selected' : ''}${isDragging ? ' dragging' : ''}`}
      onClick={onClick}
    >
      <span className="sq-drag-handle" {...attributes} {...listeners} style={{ fontSize: 16, lineHeight: 1, paddingTop: 2 }}>⠿</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: '#6c757d', marginBottom: 2 }}>
          Step {index + 1} · {step.delay.value} {step.delay.unit}
        </div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{step.action.type.replace('_', ' ')}</div>
        {step.action.type === 'send_message' || step.action.type === 'send_email'
          ? <div style={{ fontSize: 12, color: '#495057' }}>{step.action.params.template_id || '(no template)'}</div>
          : step.action.type === 'emit_event'
          ? <div style={{ fontSize: 12, color: '#495057' }}>{step.action.params.event_type || '(no event type)'}</div>
          : null}
      </div>
      {step.ab_variant_override && (
        <span style={{ fontSize: 11, background: '#cfe2ff', color: '#084298', padding: '1px 6px', borderRadius: 3, alignSelf: 'center' }}>A/B</span>
      )}
    </div>
  )
}

interface StepListProps {
  steps: StepDraft[]
  selectedStepId: string | null
  onSelectStep: (id: string) => void
  onAddStep: () => void
  onReorder: (event: DragEndEvent) => void
}

export function StepList({ steps, selectedStepId, onSelectStep, onAddStep, onReorder }: StepListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 12, background: '#f8f9fa' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6c757d', marginBottom: 8 }}>Steps</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onReorder}>
        <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {steps.map((step, i) => (
            <SortableStep
              key={step.id}
              step={step}
              index={i}
              isSelected={step.id === selectedStepId}
              onClick={() => onSelectStep(step.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        onClick={onAddStep}
        style={{ width: '100%', padding: '8px', border: '2px dashed #dee2e6', borderRadius: 6, background: 'transparent', color: '#6c757d', fontSize: 12, cursor: 'pointer', marginTop: 4 }}
      >
        + Add Step
      </button>
    </div>
  )
}
