import React, { useState, useEffect, useCallback, useMemo } from 'react'
import type { SequenceBuilderProps, ActiveHours, ABTest, StepDraft } from '../types.js'
import { SequenceApiClient } from '../api/SequenceApiClient.js'
import { GatewayApiClient } from '../api/GatewayApiClient.js'
import { useSequenceDetail } from '../hooks/useSequenceDetail.js'
import { useStepEditor } from '../hooks/useStepEditor.js'
import { StepList } from './StepList.js'
import { StepEditor } from './StepEditor.js'
import { ActiveHoursConfig } from './ActiveHoursConfig.js'
import { ABConfig } from './ABConfig.js'
import { EnrollmentLog } from './EnrollmentLog.js'
import { ABResults } from './ABResults.js'

type Tab = 'builder' | 'enrollments' | 'ab_results'

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '8px 18px',
  border: 'none',
  borderBottom: active ? '2px solid #0066cc' : '2px solid transparent',
  background: 'transparent',
  cursor: 'pointer',
  fontWeight: active ? 700 : 400,
  color: active ? '#0066cc' : '#495057',
  fontSize: 13,
})

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: '#0066cc',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
}

const secondaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: '#fff',
  color: '#495057',
  border: '1px solid #dee2e6',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
}

const dangerOutlineBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: '#fff',
  color: '#dc3545',
  border: '1px solid #dc3545',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
}

type SequenceLoaded = NonNullable<ReturnType<typeof useSequenceDetail>['sequence']>

interface InnerBuilderProps {
  sequence: SequenceLoaded
  gatewayClient: GatewayApiClient
  onDirty: () => void
  onSaveData: (steps: StepDraft[], activeHours: ActiveHours | null, abTest: ABTest | null) => void
}

/**
 * Mounts once per sequence version (keyed by sequenceId + current_version in parent).
 * Owns local steps/activeHours/abTest state; propagates changes upward.
 */
function InnerBuilder({ sequence, gatewayClient, onDirty, onSaveData }: InnerBuilderProps) {
  const [activeHours, setActiveHours] = useState<ActiveHours | null>(sequence.active_hours)
  const [abTest, setAbTest] = useState<ABTest | null>(sequence.ab_test)

  const handleStepsChange = useCallback(
    (newSteps: StepDraft[]) => {
      onDirty()
      // abTest/activeHours captured via closure are stale here — use ref approach via effect below
    },
    [onDirty],
  )

  const { steps, selectedStepId, selectStep, addStep, removeStep, updateStep, reorderSteps } =
    useStepEditor(sequence.steps, handleStepsChange)

  // Keep parent informed of latest pending save data whenever anything changes
  useEffect(() => {
    onSaveData(steps, activeHours, abTest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, activeHours, abTest])

  const handleActiveHoursChange = (v: ActiveHours | null) => {
    setActiveHours(v)
    onDirty()
  }

  const handleAbTestChange = (v: ABTest | null) => {
    setAbTest(v)
    onDirty()
  }

  const handleAddStep = () => {
    addStep()
    onDirty()
  }

  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Left panel */}
      <div
        style={{
          width: 280,
          borderRight: '1px solid #dee2e6',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <StepList
          steps={steps}
          selectedStepId={selectedStepId}
          onSelectStep={selectStep}
          onAddStep={handleAddStep}
          onReorder={reorderSteps}
        />
        <div style={{ padding: '0 12px 12px' }}>
          <ActiveHoursConfig activeHours={activeHours} onChange={handleActiveHoursChange} />
          <ABConfig abTest={abTest} onChange={handleAbTestChange} />
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {selectedStep ? (
          <StepEditor
            step={selectedStep}
            gatewayClient={gatewayClient}
            onUpdate={(updated) => {
              updateStep(updated.id, updated)
              onDirty()
            }}
            onRemove={() => {
              removeStep(selectedStep.id)
              onDirty()
            }}
          />
        ) : (
          <div style={{ padding: 24, color: '#6c757d', fontSize: 13 }}>
            Select a step to edit, or add a new step.
          </div>
        )}
      </div>
    </div>
  )
}

export function SequenceBuilder({
  sequenceId,
  nurturingEngineUrl,
  crmGatewayUrl,
  token,
  userRole,
  onBack,
}: SequenceBuilderProps) {
  const seqClient = useMemo(
    () => new SequenceApiClient(nurturingEngineUrl, token),
    [nurturingEngineUrl, token],
  )
  const gatewayClient = useMemo(
    () => new GatewayApiClient(crmGatewayUrl, token),
    [crmGatewayUrl, token],
  )

  const {
    sequence,
    loading,
    error,
    isDirty: hookDirty,
    update,
    saveDraft,
    activate,
    disable,
  } = useSequenceDetail(seqClient, sequenceId)

  const [activeTab, setActiveTab] = useState<Tab>('builder')
  const [localDirty, setLocalDirty] = useState(false)

  // Pending save data accumulated from InnerBuilder
  const [pendingSteps, setPendingSteps] = useState<StepDraft[]>([])
  const [pendingActiveHours, setPendingActiveHours] = useState<ActiveHours | null>(null)
  const [pendingAbTest, setPendingAbTest] = useState<ABTest | null>(null)

  // Key remounts InnerBuilder when sequence reloads (after save/activate)
  const builderKey = sequence
    ? `${sequence.sequence_id}-${sequence.current_version}`
    : 'loading'

  const handleDirty = useCallback(() => {
    setLocalDirty(true)
  }, [])

  const handleSaveData = useCallback(
    (steps: StepDraft[], activeHours: ActiveHours | null, abTest: ABTest | null) => {
      setPendingSteps(steps)
      setPendingActiveHours(activeHours)
      setPendingAbTest(abTest)
    },
    [],
  )

  const handleSaveDraft = async () => {
    update({ steps: pendingSteps, active_hours: pendingActiveHours, ab_test: pendingAbTest })
    await saveDraft()
    setLocalDirty(false)
  }

  const handleActivate = async () => {
    await activate()
    setLocalDirty(false)
  }

  const handleDisable = async () => {
    await disable()
  }

  const canManage = userRole === 'marketing_manager' || userRole === 'super_admin'
  const showSaveDraft = localDirty
  const showActivate = canManage && sequence?.status === 'draft' && !localDirty && !hookDirty
  const showDisable = canManage && sequence?.status === 'active'

  // Show A/B Results tab when sequence has ab_test OR local pending abTest is set
  const showAbResults =
    sequence != null && (sequence.ab_test !== null || pendingAbTest !== null)

  if (loading) {
    return <div style={{ padding: 24, color: '#6c757d', fontSize: 14 }}>Loading sequence...</div>
  }

  if (error) {
    return <div style={{ padding: 24, color: '#721c24', fontSize: 14 }}>{error}</div>
  }

  if (!sequence) {
    return <div style={{ padding: 24, color: '#6c757d', fontSize: 14 }}>Sequence not found.</div>
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderBottom: '1px solid #dee2e6',
          background: '#fff',
          flexShrink: 0,
        }}
      >
        <button style={secondaryBtn} onClick={onBack}>
          Back
        </button>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1 }}>{sequence.name}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {showSaveDraft && (
            <button style={primaryBtn} onClick={() => void handleSaveDraft()}>
              Save Draft
            </button>
          )}
          {showActivate && (
            <button style={primaryBtn} onClick={() => void handleActivate()}>
              Activate
            </button>
          )}
          {showDisable && (
            <button style={dangerOutlineBtn} onClick={() => void handleDisable()}>
              Disable
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #dee2e6',
          background: '#fff',
          flexShrink: 0,
          paddingLeft: 8,
        }}
      >
        <button
          role="tab"
          aria-selected={activeTab === 'builder'}
          style={tabBtn(activeTab === 'builder')}
          onClick={() => setActiveTab('builder')}
        >
          Builder
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'enrollments'}
          style={tabBtn(activeTab === 'enrollments')}
          onClick={() => setActiveTab('enrollments')}
        >
          Enrollments
        </button>
        {showAbResults && (
          <button
            role="tab"
            aria-selected={activeTab === 'ab_results'}
            style={tabBtn(activeTab === 'ab_results')}
            onClick={() => setActiveTab('ab_results')}
          >
            A/B Results
          </button>
        )}
      </div>

      {/* Tab content */}
      <div
        style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        {activeTab === 'builder' && (
          <InnerBuilder
            key={builderKey}
            sequence={sequence}
            gatewayClient={gatewayClient}
            onDirty={handleDirty}
            onSaveData={handleSaveData}
          />
        )}
        {activeTab === 'enrollments' && (
          <EnrollmentLog sequenceId={sequenceId} client={seqClient} />
        )}
        {activeTab === 'ab_results' && showAbResults && (
          <ABResults sequenceId={sequenceId} client={seqClient} />
        )}
      </div>
    </div>
  )
}
