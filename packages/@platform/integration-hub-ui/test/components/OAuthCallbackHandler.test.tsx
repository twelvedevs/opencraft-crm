import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { OAuthCallbackHandler } from '../../src/components/OAuthCallbackHandler.js'

function setSearch(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString()
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search: `?${search}` },
  })
}

describe('OAuthCallbackHandler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows success message for google_ads', () => {
    setSearch({ platform: 'google_ads', status: 'success' })
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByText(/Google Ads connected/i)).toBeTruthy()
    expect(screen.getByText(/redirecting/i)).toBeTruthy()
  })

  it('shows success message for facebook_ads as Meta', () => {
    setSearch({ platform: 'facebook_ads', status: 'success' })
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByText(/Meta connected/i)).toBeTruthy()
  })

  it('calls onSuccess after 1.5s delay', async () => {
    setSearch({ platform: 'google_ads', status: 'success' })
    const onSuccess = vi.fn()
    render(<OAuthCallbackHandler onSuccess={onSuccess} onError={vi.fn()} />)
    expect(onSuccess).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('shows error message and calls onError after 1.5s', async () => {
    setSearch({ platform: 'google_ads', status: 'error', message: 'Access denied' })
    const onError = vi.fn()
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={onError} />)
    expect(screen.getByText(/Connection failed/i)).toBeTruthy()
    expect(screen.getByText(/Access denied/i)).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(onError).toHaveBeenCalledWith('Access denied')
  })

  it('calls onError with default message when message param is absent', async () => {
    setSearch({ platform: 'google_ads', status: 'error' })
    const onError = vi.fn()
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={onError} />)
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(onError).toHaveBeenCalledWith('Connection failed')
  })
})
