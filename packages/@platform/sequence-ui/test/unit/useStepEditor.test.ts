import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStepEditor } from '../../src/hooks/useStepEditor.js'
import type { StepDraft } from '../../src/types.js'

// NOTE: renderHook requires @testing-library/react — add to devDependencies if not present

const smsAction = (): StepDraft['action'] => ({
  type: 'send_message',
  params: { template_id: 'tmpl-1', to_field: 'context.phone', from_field: 'context.loc', context: 'context', dedup_key: 'key-1' },
})

function makeStep(id: string): StepDraft {
  return { id, delay: { value: 24, unit: 'hours' }, action: smsAction() }
}

describe('useStepEditor', () => {
  it('initializes with provided steps and selects first step', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    expect(result.current.steps).toHaveLength(2)
    expect(result.current.selectedStepId).toBe('s1')
  })

  it('selectStep updates selectedStepId', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    act(() => result.current.selectStep('s2'))
    expect(result.current.selectedStepId).toBe('s2')
  })

  it('addStep appends a default step and selects it', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() => result.current.addStep())
    expect(result.current.steps).toHaveLength(2)
    expect(result.current.selectedStepId).toBe(result.current.steps[1].id)
    expect(onChange).toHaveBeenCalledWith(result.current.steps)
  })

  it('addStep default: 24h send_message', () => {
    const { result } = renderHook(() => useStepEditor([], vi.fn()))
    act(() => result.current.addStep())
    const step = result.current.steps[0]
    expect(step.delay).toEqual({ value: 24, unit: 'hours' })
    expect(step.action.type).toBe('send_message')
  })

  it('removeStep removes the step and calls onChange', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() => result.current.removeStep('s1'))
    expect(result.current.steps.map((s) => s.id)).toEqual(['s2'])
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 's2' })])
  })

  it('removeStep resets selectedStepId to next step when selected is removed', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    act(() => result.current.removeStep('s1'))
    expect(result.current.selectedStepId).toBe('s2')
  })

  it('removeStep sets selectedStepId to null when last step removed', () => {
    const steps = [makeStep('s1')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    act(() => result.current.removeStep('s1'))
    expect(result.current.selectedStepId).toBeNull()
  })

  it('updateStep patches the correct step and calls onChange', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() => result.current.updateStep('s1', { delay: { value: 48, unit: 'hours' } }))
    expect(result.current.steps[0].delay).toEqual({ value: 48, unit: 'hours' })
    expect(result.current.steps[1].delay).toEqual({ value: 24, unit: 'hours' }) // unchanged
    expect(onChange).toHaveBeenCalled()
  })

  it('reorderSteps moves step from old index to new index', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() =>
      result.current.reorderSteps({
        active: { id: 's1' },
        over: { id: 's3' },
      } as never),
    )
    expect(result.current.steps.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
    expect(onChange).toHaveBeenCalled()
  })

  it('reorderSteps is a no-op when active === over', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() =>
      result.current.reorderSteps({
        active: { id: 's1' },
        over: { id: 's1' },
      } as never),
    )
    expect(onChange).not.toHaveBeenCalled()
  })
})
