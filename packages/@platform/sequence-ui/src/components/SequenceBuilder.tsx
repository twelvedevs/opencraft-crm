import React, { useState, useMemo } from 'react'
import type { SequenceBuilderProps, ActiveHours, ABTest, SequenceDetail } from '../types.js'
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

interface InnerBuilderProps {
  sequence: SequenceDetail
  gatewayClient: GatewayApiClient
  update: (patch: { steps?: SequenceDetail['steps']; active_hours?: ActiveHours | null; ab_test?: ABTest | null }) => void
  onAbTestChange: (v: ABTest | null) => void
}

/**
 * Mounts once per sequence version (keyed by sequenceId + current_version in parent).
 * Pushes every mutation through `update()` so the hook's draft is the single source of truth.
 */
function InnerBuilder({ sequence, gatewayClient, update, onAbTestChange }: InnerBuilderProps) {
  const [activeHours, setActiveHours] = useState<ActiveHours | null>(sequence.active_hours)
  const [abTest, setAbTest] = useState<ABTest | null>(sequence.ab_test)

  const { steps, selectedStepId, selectStep, addStep, removeStep, updateStep, reorderSteps } =
    useStepEditor(sequence.steps, (newSteps) => update({ steps: newSteps }))

  const handleActiveHoursChange = (v: ActiveHours | null) => {
    setActiveHours(v)
    update({ active_hours: v })
  }

  const handleAbTestChange = (v: ABTest | null) => {
    setAbTest(v)
    update({ ab_test: v })
    onAbTestChange(v)
  }

  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
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
          onAddStep={addStep}
          onReorder={reorderSteps}
        />
        <div style={{ padding: '0 12px 12px' }}>
          <ActiveHoursConfig activeHours={activeHours} onChange={handleActiveHoursChange} />
          <ABConfig abTest={abTest} onChange={handleAbTestChange} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {selectedStep ? (
          <StepEditor
            step={selectedStep}
            gatewayClient={gatewayClient}
            onUpdate={(updated) => updateStep(updated.id, updated)}
            onRemove={() => removeStep(selectedStep.id)}
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

  const { sequence, loading, error, isDirty, update, saveDraft, activate, disable } =
    useSequenceDetail(seqClient, sequenceId)

  const [activeTab, setActiveTab] = useState<Tab>('builder')
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(new Set(['builder']))
  // Track A/B toggle within the current editing session so the A/B Results tab appears
  // as soon as the user enables the test (before save). Reset on remount via builderKey.
  const [pendingAbTest, setPendingAbTest] = useState<ABTest | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const selectTab = (tab: Tab) => {
    setActiveTab(tab)
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }

  const builderKey = sequence
    ? `${sequence.sequence_id}-${sequence.current_version}`
    : 'loading'

  const handleSaveDraft = async () => {
    setSaving(true)
    setActionError(null)
    try {
      await saveDraft()
      setPendingAbTest(null)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleActivate = async () => {
    setSaving(true)
    setActionError(null)
    try {
      await activate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Activate failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    setSaving(true)
    setActionError(null)
    try {
      await disable()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Disable failed')
    } finally {
      setSaving(false)
    }
  }

  const canManage = userRole === 'marketing_manager' || userRole === 'super_admin'
  const hasPendingNewVersion =
    !!sequence && sequence.active_version !== sequence.current_version
  const showSaveDraft = isDirty
  // Activate is shown when a draft-or-new-version exists, the manager role has access, and
  // there are no unsaved edits. A new version of an already-active sequence is activated
  // when current_version !== active_version.
  const showActivate =
    !!sequence &&
    canManage &&
    !isDirty &&
    (sequence.status === 'draft' || (sequence.status === 'active' && hasPendingNewVersion))
  const showDisable = canManage && sequence?.status === 'active'

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
        {actionError && (
          <span style={{ color: '#721c24', fontSize: 13 }}>{actionError}</span>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {showSaveDraft && (
            <button style={primaryBtn} disabled={saving} onClick={() => void handleSaveDraft()}>
              {saving ? 'Saving…' : 'Save Draft'}
            </button>
          )}
          {showActivate && (
            <button style={primaryBtn} disabled={saving} onClick={() => void handleActivate()}>
              Activate
            </button>
          )}
          {showDisable && (
            <button style={dangerOutlineBtn} disabled={saving} onClick={() => void handleDisable()}>
              Disable
            </button>
          )}
        </div>
      </div>

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
          onClick={() => selectTab('builder')}
        >
          Builder
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'enrollments'}
          style={tabBtn(activeTab === 'enrollments')}
          onClick={() => selectTab('enrollments')}
        >
          Enrollments
        </button>
        {showAbResults && (
          <button
            role="tab"
            aria-selected={activeTab === 'ab_results'}
            style={tabBtn(activeTab === 'ab_results')}
            onClick={() => selectTab('ab_results')}
          >
            A/B Results
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Lazy-mount each tab's content on first visit, then keep mounted so state
            persists across tab switches. `display:none` hides the inactive panel. */}
        {visitedTabs.has('builder') && (
          <div style={{ display: activeTab === 'builder' ? 'flex' : 'none', flex: 1, overflow: 'hidden', flexDirection: 'column' }}>
            <InnerBuilder
              key={builderKey}
              sequence={sequence}
              gatewayClient={gatewayClient}
              update={update}
              onAbTestChange={setPendingAbTest}
            />
          </div>
        )}
        {visitedTabs.has('enrollments') && (
          <div style={{ display: activeTab === 'enrollments' ? 'flex' : 'none', flex: 1, overflow: 'hidden', flexDirection: 'column' }}>
            <EnrollmentLog sequenceId={sequenceId} client={seqClient} />
          </div>
        )}
        {visitedTabs.has('ab_results') && showAbResults && (
          <div style={{ display: activeTab === 'ab_results' ? 'flex' : 'none', flex: 1, overflow: 'hidden', flexDirection: 'column' }}>
            <ABResults sequenceId={sequenceId} client={seqClient} />
          </div>
        )}
      </div>
    </div>
  )
}
