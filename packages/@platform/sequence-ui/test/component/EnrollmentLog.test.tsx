import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL, mockEnrollments } from '../msw-handlers.js'
import { SequenceApiClient } from '../../src/api/SequenceApiClient.js'
import { EnrollmentLog } from '../../src/components/EnrollmentLog.js'

function renderLog(sequenceId = 'seq-1') {
  const client = new SequenceApiClient(NURTURING_URL, 'tok')
  return render(<EnrollmentLog sequenceId={sequenceId} client={client} />)
}

describe('EnrollmentLog', () => {
  it('loads and renders enrollment rows', async () => {
    renderLog()
    await waitFor(() => expect(screen.getByText('enr-1')).toBeInTheDocument())
    expect(screen.getByText('enr-2')).toBeInTheDocument()
  })

  it('shows variant badge for each enrollment', async () => {
    renderLog()
    await waitFor(() => screen.getByText('enr-1'))
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('shows status for each enrollment', async () => {
    renderLog()
    await waitFor(() => screen.getByText('enr-1'))
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  it('shows error message when API fails', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences/seq-1/enrollments`, () => HttpResponse.json({}, { status: 500 })))
    renderLog()
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
  })

  it('shows empty state when no enrollments', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences/seq-1/enrollments`, () => HttpResponse.json({ data: [] })))
    renderLog()
    await waitFor(() => expect(screen.getByText(/no enrollments/i)).toBeInTheDocument())
  })
})
