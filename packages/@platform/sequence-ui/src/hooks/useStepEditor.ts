import { useState, useCallback } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { StepDraft } from '../types.js'

function newStepId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function defaultStep(): StepDraft {
  return {
    id: newStepId(),
    delay: { value: 24, unit: 'hours' },
    action: {
      type: 'send_message',
      params: { template_id: '', to_field: '', from_field: '', context: 'context', dedup_key: '' },
    },
  }
}

export interface UseStepEditorResult {
  steps: StepDraft[]
  selectedStepId: string | null
  selectStep: (id: string) => void
  addStep: () => void
  removeStep: (id: string) => void
  updateStep: (id: string, patch: Partial<StepDraft>) => void
  reorderSteps: (event: DragEndEvent) => void
}

export function useStepEditor(
  initialSteps: StepDraft[],
  onChange: (steps: StepDraft[]) => void,
): UseStepEditorResult {
  const [steps, setSteps] = useState<StepDraft[]>(initialSteps)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(
    initialSteps[0]?.id ?? null,
  )

  const update = useCallback(
    (next: StepDraft[]) => {
      setSteps(next)
      onChange(next)
    },
    [onChange],
  )

  const selectStep = useCallback((id: string) => setSelectedStepId(id), [])

  const addStep = useCallback(() => {
    const step = defaultStep()
    const next = [...steps, step]
    setSteps(next)
    onChange(next)
    setSelectedStepId(step.id)
  }, [steps, onChange])

  const removeStep = useCallback(
    (id: string) => {
      const next = steps.filter((s) => s.id !== id)
      setSteps(next)
      onChange(next)
      if (selectedStepId === id) {
        setSelectedStepId(next[0]?.id ?? null)
      }
    },
    [steps, selectedStepId, onChange],
  )

  const updateStep = useCallback(
    (id: string, patch: Partial<StepDraft>) => {
      update(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    },
    [steps, update],
  )

  const reorderSteps = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = steps.findIndex((s) => s.id === active.id)
      const newIndex = steps.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      update(arrayMove(steps, oldIndex, newIndex))
    },
    [steps, update],
  )

  return { steps, selectedStepId, selectStep, addStep, removeStep, updateStep, reorderSteps }
}
