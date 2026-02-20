import { useState, useEffect } from 'react'
import './App.css'
import VATimeline from './VATimeline'

// In dev we use Vite proxy (''). In production, use env VITE_API_BASE or the default below (e.g. Railway backend).
const DEFAULT_PRODUCTION_API = 'https://bsc-website-production.up.railway.app'
const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? DEFAULT_PRODUCTION_API : '')
const DEFAULT_PRODUCTION_VA_API = 'https://cozy-achievement-production-8d99.up.railway.app'
const VA_API_BASE = import.meta.env.VITE_VA_API_BASE ?? (import.meta.env.PROD ? DEFAULT_PRODUCTION_VA_API : 'http://localhost:5000')

const STORED_CLIENT_ID_KEY = 'bsc_stored_client_id'
const TITLE_BASE = 'BSC Research'

function getStoredClientId() {
  try {
    let id = localStorage.getItem(STORED_CLIENT_ID_KEY)
    if (!id) {
      id = 'bsc_' + crypto.randomUUID()
      localStorage.setItem(STORED_CLIENT_ID_KEY, id)
    }
    return id
  } catch (_) {
    return null
  }
}

/** Normalize YouTube input to full watch URL (handles bare ID, youtu.be, etc.). */
function normalizeYoutubeUrl(input) {
  const s = (input || '').trim()
  if (!s) return ''
  const idMatch = s.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|^)([a-zA-Z0-9_-]{11})(?:\?|&|$|\/)/)
  if (idMatch) return `https://www.youtube.com/watch?v=${idMatch[1]}`
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`
  return s
}

/** Format stored_at_utc (e.g. 20250120T143022Z) for display. */
function formatStoredTimestamp(utc) {
  if (!utc || typeof utc !== 'string') return utc || ''
  const m = utc.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/)
  if (!m) return utc
  const [, y, mon, d, h, min] = m
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[parseInt(mon, 10) - 1]} ${y}, ${h}:${min}`
}

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [storePassword, setStorePassword] = useState('')
  const [view, setView] = useState('analyze') // 'analyze' | 'stored' | 'results' | 'msa'
  const [lastVcmResult, setLastVcmResult] = useState(null) // best/latest VCM result for Results tab
  const [lastMsaResult, setLastMsaResult] = useState(null) // best/latest MSA result for Results tab
  const [storedData, setStoredData] = useState(null) // { neutral: [...], sad: [...], ... }
  const [storedLoading, setStoredLoading] = useState(false)
  const [storedCategory, setStoredCategory] = useState(null) // null = show 4 buttons; 'sad' etc = show that category's page
  const [deleteTarget, setDeleteTarget] = useState(null) // { emotion, video_id, stored_at_utc } when user clicked Delete
  const [deletePassword, setDeletePassword] = useState('') // only used in the row that's in "confirm delete" mode
  const [deletingId, setDeletingId] = useState(null) // video_id+stored_at_utc while delete in progress
  const [popoutMsaData, setPopoutMsaData] = useState(null) // when opening as ?popout=msa

  // Restore view from URL (?view=, ?va=/?msa= for MSA, ?popout=msa)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('popout') === 'msa') {
      try {
        const raw = sessionStorage.getItem('msaPopoutData')
        if (raw) {
          const data = JSON.parse(raw)
          if (data?.result?.timeline && data?.result?.videoUrl) setPopoutMsaData(data)
        }
      } catch (_) {}
      return
    }
    const vaId = params.get('va') || params.get('msa')
    if (vaId) {
      try {
        const key = 'msaResult_' + (vaId.startsWith('va_') ? vaId : 'va_' + vaId)
        const raw = sessionStorage.getItem(key) || sessionStorage.getItem('msaResult')
        if (raw) {
          const data = JSON.parse(raw)
          if (data?.videoUrl) {
            setLastMsaResult(data)
            setView('msa')
            return
          }
        }
      } catch (_) {}
    }
    const viewParam = params.get('view')
    if (['analyze', 'stored', 'results', 'msa'].includes(viewParam)) setView(viewParam)
  }, [])

  // Sync document title and URL with current view
  useEffect(() => {
    const titles = { analyze: 'Analyze', stored: 'Stored', results: 'Results', msa: 'MSA' }
    document.title = `${titles[view] || 'Analyze'} – ${TITLE_BASE}`
    const url = new URL(window.location.href)
    if (url.searchParams.get('view') !== view) {
      url.searchParams.set('view', view)
      const search = url.searchParams.toString()
      window.history.replaceState({}, '', url.pathname + (search ? '?' + search : ''))
    }
  }, [view])

  const STORED_VCM = [
    { key: 'neutral', label: 'Neutral' },
    { key: 'pleased', label: 'Pleased' },
    { key: 'funny', label: 'Funny' },
    { key: 'fear', label: 'Fear' },
    { key: 'sad', label: 'Sad' },
  ]
  const STORED_MSA = [
    { key: 'high_v_low_a', label: 'High V, Low A' },
    { key: 'low_v_high_a', label: 'Low V, High A' },
    { key: 'high_v_high_a', label: 'High V, High A' },
    { key: 'low_v_low_a', label: 'Low V, Low A' },
  ]
  const STORED_EMOTIONS = [...STORED_VCM, ...STORED_MSA]

  async function handleAnalyze(e) {
    e.preventDefault()
    const normalized = normalizeYoutubeUrl(url)
    if (!normalized) return
    setError(null)
    setResult(null)
    setProgress('')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/analyze-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_url: normalized }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || res.statusText)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'progress') setProgress(obj.message)
              if (obj.type === 'result') {
                setResult(obj.data)
                setLastVcmResult(obj.data)
              }
              if (obj.type === 'error') throw new Error(obj.detail)
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) continue
              throw parseErr
            }
          }
      }
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer)
          if (obj.type === 'result') {
            setResult(obj.data)
            setLastVcmResult(obj.data)
          }
          if (obj.type === 'error') throw new Error(obj.detail)
        } catch (_) {}
      }
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  async function handleStore(storeUnderEmotion = null) {
    if (!result || !result.video_id) return
    setError(null)
    setSaveStatus(null)
    setSaving(true)
    try {
      const payload = {
        store_password: storePassword,
        video_id: result.video_id,
        title: result.title || '',
        video_emotion: result.video_emotion,
        video_emotion_code: result.video_emotion_code,
        stage2_emotion: result.stage2_emotion,
        stage2_emotion_code: result.stage2_emotion_code,
        stage2_emotion_2: result.stage2_emotion_2,
        stage2_emotion_code_2: result.stage2_emotion_code_2,
        emotion_percentages: result.emotion_percentages,
        comment_count: result.comment_count,
        store_under_emotion: storeUnderEmotion ?? undefined,
        client_id: getStoredClientId(),
      }
      const res = await fetch(`${API_BASE}/api/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || res.statusText)
      }
      const data = await res.json()
      setSaveStatus(`Stored under ${data.stored_in}/${data.filename}`)
      setStorePassword('')
    } catch (err) {
      setError(err.message || 'Failed to store video.')
    } finally {
      setSaving(false)
    }
  }

  async function loadStored() {
    setView('stored')
    setStoredCategory(null)
    setError(null)
    setStorePassword('')
    setDeletePassword('')
    setDeleteTarget(null)
    setStoredLoading(true)
    setStoredData(null)
    try {
      const clientId = getStoredClientId()
      const url = clientId ? `${API_BASE}/api/stored?client_id=${encodeURIComponent(clientId)}` : `${API_BASE}/api/stored`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to load stored videos')
      const data = await res.json()
      setStoredData(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setStoredLoading(false)
    }
  }

  async function handleDeleteStored(emotion, videoId, storedAtUtc, password) {
    if (!password || !String(password).trim()) {
      setError('Enter delete password')
      return
    }
    const id = `${videoId}-${storedAtUtc}`
    setDeletingId(id)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/stored/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delete_password: password.trim(),
          emotion,
          video_id: videoId,
          stored_at_utc: storedAtUtc,
          client_id: getStoredClientId(),
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        let detail = res.statusText
        try {
          const errData = JSON.parse(text)
          if (errData.detail) detail = typeof errData.detail === 'string' ? errData.detail : JSON.stringify(errData.detail)
        } catch (_) {}
        throw new Error(detail)
      }
      setDeleteTarget(null)
      setDeletePassword('')
      const clientId = getStoredClientId()
      const listUrl = clientId ? `${API_BASE}/api/stored?client_id=${encodeURIComponent(clientId)}` : `${API_BASE}/api/stored`
      const listRes = await fetch(listUrl)
      if (listRes.ok) {
        const data = await listRes.json()
        setStoredData(data)
      }
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setDeletingId(null)
    }
  }

  if (popoutMsaData) {
    return (
      <div className="app app-popout">
        <header className="header">
          <h1>MSA (continuous) — Pop out</h1>
          <p className="tagline">Video &amp; valence/arousal timeline</p>
        </header>
        <main className="main">
          <section className="card msa-section">
            <VATimeline displayOnlyResult={popoutMsaData.result} storeApiBase={popoutMsaData.storeApiBase} storeClientId={getStoredClientId()} />
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>BSC Research</h1>
        <p className="tagline">BSC-VCM-MSA</p>
        <nav className="nav-tabs" role="tablist" aria-label="Main sections">
          <button
            type="button"
            id="tab-analyze"
            role="tab"
            aria-selected={view === 'analyze'}
            aria-controls="panel-main"
            className={`nav-tab ${view === 'analyze' ? 'active' : ''}`}
            onClick={() => { setView('analyze'); setError(null); setStorePassword(''); setDeletePassword(''); setDeleteTarget(null); }}
          >
            Analyze
          </button>
          <button
            type="button"
            id="tab-stored"
            role="tab"
            aria-selected={view === 'stored'}
            aria-controls="panel-main"
            className={`nav-tab ${view === 'stored' ? 'active' : ''}`}
            onClick={loadStored}
          >
            Stored
          </button>
          <button
            type="button"
            id="tab-results"
            role="tab"
            aria-selected={view === 'results'}
            aria-controls="panel-main"
            className={`nav-tab ${view === 'results' ? 'active' : ''}`}
            onClick={() => { setView('results'); setError(null); setStorePassword(''); setDeletePassword(''); setDeleteTarget(null); }}
          >
            Results
          </button>
          <button
            type="button"
            id="tab-msa"
            role="tab"
            aria-selected={view === 'msa'}
            aria-controls="panel-main"
            className={`nav-tab ${view === 'msa' ? 'active' : ''}`}
            onClick={() => { setView('msa'); setError(null); setStorePassword(''); setDeletePassword(''); setDeleteTarget(null); }}
          >
            MSA
          </button>
        </nav>
      </header>

      <main className="main" id="panel-main" role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === 'stored' && (
          <section className="card stored-section">
            <h2>Stored videos</h2>
            <p className="hint">Videos stored by researchers. Pick an emotion to see its videos.</p>
            {storedLoading ? (
              <p className="progress">Loading…</p>
            ) : storedData && Object.keys(storedData).length === 0 ? (
              <>
                <p className="hint">No stored videos yet.</p>
                <p className="hint stored-empty-hint">Analyze a video or run MSA, then use the store password to save results here.</p>
              </>
            ) : storedCategory != null ? (
              <>
                <button
                  type="button"
                  className="btn stored-back-btn"
                  onClick={() => { setStoredCategory(null); setDeletePassword(''); setDeleteTarget(null); }}
                >
                  ← Back to categories
                </button>
                <h3 className="stored-category-title">{STORED_EMOTIONS.find(e => e.key === storedCategory)?.label ?? storedCategory}</h3>
                {error && (
                  <p className="error" role="alert" aria-live="polite">
                    {error}
                    <button type="button" className="btn btn-inline-retry" onClick={() => { setError(null); loadStored(); }}>
                      Retry
                    </button>
                  </p>
                )}
                <ul className="stored-video-list">
                  {(storedData && storedData[storedCategory] ? storedData[storedCategory] : []).map((v, i) => {
                    const isDeleteTarget = deleteTarget && deleteTarget.video_id === v.video_id && deleteTarget.stored_at_utc === v.stored_at_utc
                    const isDeleting = deletingId === `${v.video_id}-${v.stored_at_utc}`
                    const isMsaCategory = STORED_MSA.some(e => e.key === storedCategory)
                    const suffix = String(v.video_id || '').replace(/^va_/, '')
                    const hasExt = suffix.includes('.')
                    const fileExt = hasExt ? suffix.slice(suffix.lastIndexOf('.')) : '.mp4'
                    const downloadUrl = isMsaCategory && v.video_id
                      ? `${VA_API_BASE.replace(/\/$/, '')}/uploads/${hasExt ? suffix : suffix + '.mp4'}`
                      : null
                    const downloadName = v.title ? `${v.title}${fileExt}` : (hasExt ? suffix : 'clip.mp4')
                    return (
                      <li key={`${v.video_id}-${v.stored_at_utc}-${i}`} className="stored-video-item">
                        {downloadUrl ? (
                          <>
                            <span className="stored-video-title">{v.title || v.video_id}</span>
                            {v.stored_at_utc && (
                              <span className="stored-meta"> · {formatStoredTimestamp(v.stored_at_utc)}</span>
                            )}
                            <a href={downloadUrl} download={downloadName} className="btn btn-download-stored">
                              Download
                            </a>
                          </>
                        ) : (
                          <>
                            <a
                              href={`https://www.youtube.com/watch?v=${v.video_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="stored-video-link"
                            >
                              {v.title || v.video_id}
                            </a>
                            {v.stored_at_utc && (
                              <span className="stored-meta"> · {formatStoredTimestamp(v.stored_at_utc)}</span>
                            )}
                          </>
                        )}
                        {!isDeleteTarget ? (
                          <button
                            type="button"
                            className="btn btn-delete-stored"
                            onClick={() => {
                              setError(null)
                              setDeletePassword('')
                              setDeleteTarget({ emotion: storedCategory, video_id: v.video_id, stored_at_utc: v.stored_at_utc })
                            }}
                            disabled={isDeleting}
                          >
                            Delete
                          </button>
                        ) : (
                          <span className="stored-delete-inline">
                            <span className="stored-delete-confirm-text">
                              Delete &quot;{v.title || v.video_id}&quot;?
                            </span>
                            <input
                              type="password"
                              placeholder="Delete password"
                              value={deletePassword}
                              onChange={(e) => setDeletePassword(e.target.value)}
                              className="input stored-delete-pw-input"
                              autoComplete="off"
                              aria-label="Delete password"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  handleDeleteStored(storedCategory, v.video_id, v.stored_at_utc, e.target.value || deletePassword)
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn-confirm-delete"
                              onClick={(e) => {
                                e.preventDefault()
                                const pwInput = e.currentTarget.closest('.stored-delete-inline')?.querySelector('input[type="password"]')
                                const pw = pwInput ? pwInput.value : deletePassword
                                handleDeleteStored(storedCategory, v.video_id, v.stored_at_utc, pw)
                              }}
                              disabled={isDeleting}
                            >
                              {isDeleting ? 'Deleting…' : 'Confirm delete'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-cancel-delete"
                              onClick={() => { setDeleteTarget(null); setDeletePassword(''); setError(null); }}
                              disabled={isDeleting}
                            >
                              Cancel
                            </button>
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {(!storedData || !storedData[storedCategory] || storedData[storedCategory].length === 0) && (
                  <p className="hint">No videos in this category yet.</p>
                )}
              </>
            ) : storedData ? (
              <>
                <div className="stored-block">
                  <h3 className="stored-block-title">VCM</h3>
                  <div className="stored-buttons">
                    {STORED_VCM.map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        className="btn stored-emotion-btn"
                        onClick={() => setStoredCategory(key)}
                      >
                        {label} ({(storedData && storedData[key]) ? storedData[key].length : 0})
                      </button>
                    ))}
                  </div>
                </div>
                <div className="stored-block">
                  <h3 className="stored-block-title">MSA - continuous</h3>
                  <div className="stored-buttons">
                    {STORED_MSA.map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        className="btn stored-emotion-btn"
                        onClick={() => setStoredCategory(key)}
                      >
                        {label} ({(storedData && storedData[key]) ? storedData[key].length : 0})
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </section>
        )}

        {view === 'results' && (
          <section className="card results-tab-section">
            <h2>Results — VCM</h2>
            <p className="hint">Your latest YouTube comment analysis. Run a new analysis on the Analyze tab to update.</p>
            <div className="card results-block">
              <h3>Latest VCM result</h3>
              {lastVcmResult ? (
                <div className="video-summary">
                  <h4>{lastVcmResult.title || `Video ${lastVcmResult.video_id}`}</h4>
                  <a
                    href={`https://www.youtube.com/watch?v=${lastVcmResult.video_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="video-link"
                  >
                    Watch on YouTube ↗
                  </a>
                  {lastVcmResult.video_emotion && (
                    <p className="overall-emotion">
                      Dominant: <strong>{lastVcmResult.stage2_emotion ?? lastVcmResult.video_emotion}</strong>
                      {lastVcmResult.stage2_emotion_2 != null && lastVcmResult.stage2_emotion_2 !== '' && (
                        <> · 2nd: <strong>{lastVcmResult.stage2_emotion_2}</strong></>
                      )}
                    </p>
                  )}
                  {lastVcmResult.emotion_percentages && (
                    <ul className="percent-list">
                      {Object.entries(lastVcmResult.emotion_percentages).map(([name, pct]) => (
                        <li key={name} className={lastVcmResult.video_emotion === name ? 'percent-item prominent' : 'percent-item'}>
                          <span className="emotion-name">{name}</span>
                          <span className="emotion-pct">{pct}%</span>
                          <span className="pct-track"><span className="pct-bar" style={{ width: `${pct}%` }} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="hint">Comments analyzed: {lastVcmResult.comment_count ?? 0}</p>
                </div>
              ) : (
                <p className="hint">No VCM result yet. Analyze a YouTube video on the Analyze tab.</p>
              )}
            </div>
          </section>
        )}

        {view === 'msa' && (
          <section className="card msa-tab-section">
            <h2>MSA (continuous)</h2>
            <p className="hint">Valence/arousal timeline from your latest MP4 upload. Upload more on the Analyze tab.</p>
            {lastMsaResult ? (
              <div className="msa-section">
                <div className="msa-actions-row">
                  <button
                    type="button"
                    className="btn msa-popout-btn"
                    onClick={() => {
                      try {
                        sessionStorage.setItem('msaPopoutData', JSON.stringify({ result: lastMsaResult, storeApiBase: API_BASE }))
                        window.open(`${window.location.origin}${window.location.pathname}?popout=msa`, '_blank', 'width=960,height=900')
                      } catch (e) {
                        console.error(e)
                      }
                    }}
                  >
                    Pop out to new window
                  </button>
                  <button
                    type="button"
                    className="btn msa-clear-btn"
                    onClick={() => {
                      setLastMsaResult(null)
                      try {
                        sessionStorage.removeItem('msaResult')
                        sessionStorage.removeItem('msaPopoutData')
                        const keysToRemove = []
                        for (let i = 0; i < sessionStorage.length; i++) {
                          const k = sessionStorage.key(i)
                          if (k && k.startsWith('msaResult_')) keysToRemove.push(k)
                        }
                        keysToRemove.forEach(k => sessionStorage.removeItem(k))
                        const url = new URL(window.location.href)
                        url.searchParams.delete('va')
                        url.searchParams.delete('msa')
                        window.history.replaceState({}, '', url.pathname + (url.search || ''))
                      } catch (e) {
                        console.error(e)
                      }
                    }}
                  >
                    Clear cached video
                  </button>
                </div>
                <VATimeline displayOnlyResult={lastMsaResult} storeApiBase={API_BASE} storeClientId={getStoredClientId()} />
              </div>
            ) : (
              <p className="hint">No MSA result yet. Upload an MP4 or MOV on the Analyze tab (MSA section); you’ll be brought here to view the video and timeline.</p>
            )}
          </section>
        )}

        {view === 'analyze' && (
        <>
        <section className="card input-section">
          <h2>Analyze a YouTube video</h2>
          <p className="hint">Paste a YouTube URL. We fetch comments, run each through the emotion model, then show the percentage of each emotion and the most prominent one.</p>
          <form onSubmit={handleAnalyze} className="form">
            <input
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="input"
              disabled={loading}
            />
            <button type="submit" className="btn" disabled={loading}>
              {loading ? 'Analyzing…' : 'Analyze'}
            </button>
          </form>
          {loading && (
            <p className="progress">{progress || 'Starting analysis…'}</p>
          )}
          {error && (
            <p className="error" role="alert" aria-live="polite">
              {error}
              <button type="button" className="btn btn-inline-retry" onClick={() => { setError(null); handleAnalyze({ preventDefault: () => {} }); }}>
                Retry
              </button>
            </p>
          )}
        </section>

        {result && (
          <section className="card results-section">
            <h2>Results</h2>
            <div className="video-summary">
              <h3>{result.title || `Video ${result.video_id}`}</h3>
              <a
                href={`https://www.youtube.com/watch?v=${result.video_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="video-link"
              >
                Watch on YouTube ↗
              </a>
              <div className="store-row">
                <input
                  type="password"
                  placeholder="Store password"
                  value={storePassword}
                  onChange={(e) => setStorePassword(e.target.value)}
                  className="input store-password-input"
                  disabled={saving}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn store-btn"
                  onClick={() => handleStore(result.stage2_emotion ?? result.video_emotion)}
                  disabled={saving}
                  title="Store under 1st dominant"
                >
                  {saving ? 'Storing…' : `Store under 1st (${result.stage2_emotion ?? result.video_emotion ?? 'prominent'})`}
                </button>
                {result.stage2_emotion_2 != null && result.stage2_emotion_2 !== '' && (
                  <button
                    type="button"
                    className="btn store-btn store-btn-2nd"
                    onClick={() => handleStore(result.stage2_emotion_2)}
                    disabled={saving}
                    title="Store under 2nd dominant"
                  >
                    {saving ? 'Storing…' : `Store under 2nd (${result.stage2_emotion_2})`}
                  </button>
                )}
              </div>
              {saveStatus && (
                <p className="hint store-status store-status-success" role="status">{saveStatus}</p>
              )}
              {result.video_emotion != null || result.emotion_percentages || result.stage2_emotion ? (
                <div className="final-emotion-box">
                  <span className="final-emotion-label">Video emotion</span>
                  {result.video_emotion != null && (
                    <p className="prominent-emotion">
                      Most prominent (from counts): <span className={`emotion-badge emotion-${result.video_emotion} final-emotion-badge`}>{result.video_emotion}</span>
                    </p>
                  )}
                  <p className="prominent-emotion stage2-row">
                    Stage 2 model (RF) 1st:{' '}
                    {result.stage2_emotion != null ? (
                      <span className={`emotion-badge emotion-${result.stage2_emotion} final-emotion-badge`}>{result.stage2_emotion}</span>
                    ) : (
                      <span className="stage2-unavailable">—</span>
                    )}
                    {result.stage2_emotion_2 != null && result.stage2_emotion_2 !== '' && (
                      <>
                        {' · '}2nd:{' '}
                        <span className={`emotion-badge emotion-${result.stage2_emotion_2} final-emotion-badge`}>{result.stage2_emotion_2}</span>
                      </>
                    )}
                  </p>
                  {result.emotion_percentages && (
                    <div className="emotion-percentages">
                      <span className="percentages-label">All emotions (sum = 100%)</span>
                      <ul className="percentages-list">
                        {Object.entries(result.emotion_percentages).map(([name, pct]) => (
                          <li key={name} className={result.video_emotion === name ? 'percent-item prominent' : 'percent-item'}>
                            <span className="emotion-name">{name}</span>
                            <span className="emotion-pct">{pct}%</span>
                            <span className="pct-track"><span className="pct-bar" style={{ width: `${pct}%` }} /></span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="overall-emotion hint">No comments analyzed. Per-comment emotions below.</p>
              )}
            </div>
            <h4>Comments & predictions ({result.comment_count})</h4>
            <ul className="comment-list">
              {result.comments.map((c, i) => (
                <li key={i} className="comment">
                  <span className={`emotion-badge emotion-${c.emotion}`}>{c.emotion}</span>
                  <span className="comment-text">{c.text}</span>
                  <span className="comment-meta">@{c.author} · {c.like_count} likes</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card msa-section">
          <h2>MSA (continuous)</h2>
          <p className="hint">Upload an MP4 or MOV for valence/arousal (V/A) timeline.</p>
          <VATimeline
            apiBaseUrl={VA_API_BASE}
            storeApiBase={API_BASE}
            storeClientId={getStoredClientId()}
            onMsaResult={(r) => {
              setLastMsaResult(r)
              setView('msa')
              try {
                sessionStorage.setItem('msaPopoutData', JSON.stringify({ result: r, storeApiBase: API_BASE }))
                const vaId = (r.vaUploadId || '').replace(/^va_/, '') || 'va_upload'
                sessionStorage.setItem('msaResult', JSON.stringify(r))
                if (r.vaUploadId) sessionStorage.setItem('msaResult_' + r.vaUploadId, JSON.stringify(r))
                const url = new URL(window.location.href)
                url.searchParams.set('va', vaId)
                window.history.replaceState({}, '', url.pathname + '?' + url.searchParams.toString())
                window.open(`${window.location.origin}${window.location.pathname}?popout=msa`, '_blank', 'width=960,height=900')
              } catch (e) {
                console.error(e)
              }
            }}
          />
          <p className="hint msa-timing-hint">First run may take 1–2 minutes while the model loads; later runs are faster.</p>
        </section>
        </>
        )}
      </main>

      <footer className="footer">
        BSC Research · VCM &amp; MSA
      </footer>
    </div>
  )
}

export default App
