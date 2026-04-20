import React, { useEffect, useState } from 'react'

const MAX_MESSAGE_LENGTH = 200

// `message` comes from an untrusted URL param. React escapes it when rendered,
// but callers must not use it for navigation — sanitize here to keep length
// bounded and strip C0/C1 control characters.
function sanitizeMessage(raw: string): string {
  return raw.replace(/[\x00-\x1F\x7F]/g, '').slice(0, MAX_MESSAGE_LENGTH)
}

export interface OAuthCallbackHandlerProps {
  onSuccess: () => void
  onError: (message: string) => void
}

export function OAuthCallbackHandler({ onSuccess, onError }: OAuthCallbackHandlerProps) {
  const [state, setState] = useState<{ ok: boolean; platformLabel: string; message: string } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const platform = params.get('platform') ?? ''
    const status = params.get('status')
    const message = sanitizeMessage(params.get('message') ?? 'Connection failed')
    const ok = status === 'success'
    const platformLabel = platform === 'facebook_ads' ? 'Meta' : 'Google Ads'

    setState({ ok, platformLabel, message })

    const timer = setTimeout(() => {
      if (ok) onSuccess()
      else onError(message)
    }, 1500)

    return () => clearTimeout(timer)
  }, [onSuccess, onError])

  if (!state) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{
        padding: '24px 32px',
        border: `1px solid ${state.ok ? '#c8e6c9' : '#ffcdd2'}`,
        borderRadius: 8,
        background: state.ok ? '#f9fff9' : '#fff9f9',
        textAlign: 'center',
        maxWidth: 360,
      }}>
        <div style={{
          fontWeight: 600,
          color: state.ok ? '#2e7d32' : '#c62828',
          marginBottom: 8,
          fontSize: 15,
        }}>
          {state.ok ? `✓ ${state.platformLabel} connected` : 'Connection failed'}
        </div>
        <div style={{ color: '#666', fontSize: 13 }}>
          {state.ok
            ? 'Redirecting to integrations…'
            : `${state.message} — redirecting…`}
        </div>
      </div>
    </div>
  )
}
