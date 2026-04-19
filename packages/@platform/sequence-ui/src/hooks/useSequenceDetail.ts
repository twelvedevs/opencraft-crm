import { useState, useEffect, useCallback, useRef } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { SequenceDetail, SequenceDraftPayload } from '../types.js'

export interface UseSequenceDetailResult {
  sequence: SequenceDetail | null
  loading: boolean
  error: string | null
  isDirty: boolean
  update: (patch: Partial<SequenceDraftPayload>) => void
  saveDraft: () => Promise<void>
  activate: () => Promise<void>
}

export function useSequenceDetail(
  client: SequenceApiClient,
  sequenceId: string,
): UseSequenceDetailResult {
  const [sequence, setSequence] = useState<SequenceDetail | null>(null)
  const [draft, setDraft] = useState<Partial<SequenceDraftPayload>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    client
      .getSequence(sequenceId)
      .then((s) => {
        if (!cancelled) {
          setSequence(s)
          setDraft({})
          setIsDirty(false)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load sequence')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, sequenceId])

  useEffect(() => load(), [load])

  const update = useCallback((patch: Partial<SequenceDraftPayload>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setIsDirty(true)
  }, [])

  const saveDraft = useCallback(async () => {
    if (!sequence) return
    const payload: SequenceDraftPayload = {
      name: sequence.name,
      active_hours: sequence.active_hours,
      cancel_on_opt_out: sequence.cancel_on_opt_out,
      steps: sequence.steps,
      ab_test: sequence.ab_test,
      ...draftRef.current,
    }
    await client.saveDraft(sequenceId, payload)
    load()
  }, [client, sequenceId, sequence, load])

  const activate = useCallback(async () => {
    await client.activate(sequenceId)
    load()
  }, [client, sequenceId, load])

  return { sequence, loading, error, isDirty, update, saveDraft, activate }
}
