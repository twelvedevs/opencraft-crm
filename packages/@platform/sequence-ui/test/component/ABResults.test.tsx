import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL, mockStats } from '../msw-handlers.js'
import { SequenceApiClient } from '../../src/api/SequenceApiClient.js'
import { ABResults } from '../../src/components/ABResults.js'

function renderResults(sequenceId = 'seq-1') {
  const client = new SequenceApiClient(NURTURING_URL, 'tok')
  return render(<ABResults sequenceId={sequenceId} client={client} />)
}

describe('ABResults', () => {
  it('renders A and B variant stats after loading', async () => {
    renderResults()
    await waitFor(() => expect(screen.getByText('Variant A')).toBeInTheDocument())
    expect(screen.getByText('Variant B')).toBeInTheDocument()
  })

  it('shows winner badge when stats include a winner', async () => {
    renderResults()
    await waitFor(() => expect(screen.getByText(/winner/i)).toBeInTheDocument())
    expect(screen.getByText('Variant A')).toBeInTheDocument()
  })

  it('shows conversion rates', async () => {
    renderResults()
    await waitFor(() => expect(screen.getByText('24%')).toBeInTheDocument())
    expect(screen.getByText('17%')).toBeInTheDocument()
  })

  it('shows error when API fails', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences/seq-1/stats`, () => HttpResponse.json({}, { status: 500 })))
    renderResults()
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
  })

  it('shows "no data" when stats have no ab field', async () => {
    server.use(
      http.get(`${NURTURING_URL}/sequences/seq-1/stats`, () =>
        HttpResponse.json({ ...mockStats, ab: null }),
      ),
    )
    renderResults()
    await waitFor(() => expect(screen.getByText(/no a\/b data/i)).toBeInTheDocument())
  })
})
