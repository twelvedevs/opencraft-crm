import React, { useState, useEffect, useRef } from 'react'
import type { GatewayApiClient } from '../api/GatewayApiClient.js'
import type { TemplateSummary } from '../types.js'
import { btn } from './utils.js'

interface Props {
  client: GatewayApiClient
  channel: 'sms' | 'email'
  onSelect: (templateId: string) => void
  onClose: () => void
}

export function TemplatePicker({ client, channel, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = (q: string) => {
    setLoading(true)
    client
      .searchTemplates(channel, q)
      .then((res) => { setTemplates(res); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { search('') }, [])

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(q), 300)
  }

  const handleSelect = (t: TemplateSummary) => {
    setSelectedId(t.template_id)
    onSelect(t.template_id)
    onClose()
  }

  return (
    <div className="sq-modal-overlay" onClick={onClose}>
      <div
        style={{ background: '#fff', borderRadius: 8, padding: 20, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,.2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>Choose Template</strong>
          <button style={btn} onClick={onClose}>✕</button>
        </div>
        <input
          role="searchbox"
          style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13, marginBottom: 10 }}
          placeholder="Search templates..."
          value={query}
          onChange={handleQueryChange}
        />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ padding: 12, color: '#6c757d', fontSize: 13 }}>Loading...</div>}
          {!loading && templates.length === 0 && <div style={{ padding: 12, color: '#6c757d', fontSize: 13 }}>No templates found.</div>}
          {templates.map((t) => (
            <div
              key={t.template_id}
              className={`sq-template-item${selectedId === t.template_id ? ' selected' : ''}`}
              onClick={() => handleSelect(t)}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: '#6c757d', marginTop: 2 }}>{t.preview}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
