import { useState, useEffect } from 'react'
import './App.css'
import VATimeline from './VATimeline'

// In dev we use Vite proxy (''). In production, use env VITE_API_BASE or the default below (e.g. Railway backend).
const DEFAULT_PRODUCTION_API = 'https://bsc-website-production.up.railway.app'
const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? DEFAULT_PRODUCTION_API : '')
const DEFAULT_PRODUCTION_VA_API = 'https://cozy-achievement-production-8d99.up.railway.app'
const VA_API_BASE = import.meta.env.VITE_VA_API_BASE ?? (import.meta.env.PROD ? DEFAULT_PRODUCTION_VA_API : 'http://localhost:5000')

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
    }
  }, [])

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
    if (!url.trim()) return
    setError(null)
    setResult(null)
    setProgress('')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/analyze-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_url: url.trim() }),
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
      const res = await fetch(`${API_BASE}/api/stored`)
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
      const listRes = await fetch(`${API_BASE}/api/stored`)
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
            <VATimeline displayOnlyResult={popoutMsaData.result} storeApiBase={popoutMsaData.storeApiBase} />
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
        <nav className="nav-tabs">
          <button
            type="button"
            className={`nav-tab ${view === 'analyze' ? 'active' : ''}`}
            onClick={() => { setView('analyze'); setError(null); setStorePassword(''); setDeletePassword(''); setDeleteTarget(null); }}
          >
            Analyze
          </button>
          <button
            type="button"
            className={`nav-tab ${view === 'stored' ? 'active' : ''}`}
            onClick={loadStored}
          >
            Stored
          </button>
          <button
            type="button"
            className={`nav-tab ${view === 'results' ? 'active' : ''}`}
            onClick={() => { setView('results'); setError(null); setStorePassword(''); setDeletePassword(''); setDeleteTarget(null); }}
          >
            Results
          </button>
          <button
            type="button"
            className={`nav-tab ${view === 'msa' ? 'active' : ''}`}
            onClick={() => { setView('msa'); setError(null); setStorePassword(''); setDeletePassword(''); setDeleteTarget(null); }}
          >
            MSA
          </button>
        </nav>
      </header>

      <main className="main">
        {view === 'stored' && (
          <section className="card stored-section">
            <h2>Stored videos</h2>
            <p className="hint">Videos stored by researchers. Pick an emotion to see its videos.</p>
            {storedLoading ? (
              <p className="progress">Loading…</p>
            ) : storedData && Object.keys(storedData).length === 0 ? (
              <p className="hint">No stored videos yet.</p>
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
                {error && <p className="error">{error}</p>}
                <ul className="stored-video-list">
                  {(storedData && storedData[storedCategory] ? storedData[storedCategory] : []).map((v, i) => {
                    const isDeleteTarget = deleteTarget && deleteTarget.video_id === v.video_id && deleteTarget.stored_at_utc === v.stored_at_utc
                    const isDeleting = deletingId === `${v.video_id}-${v.stored_at_utc}`
                    return (
                      <li key={`${v.video_id}-${v.stored_at_utc}-${i}`} className="stored-video-item">
                        <a
                          href={`https://www.youtube.com/watch?v=${v.video_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="stored-video-link"
                        >
                          {v.title || v.video_id}
                        </a>
                        {v.stored_at_utc && (
                          <span className="stored-meta"> · {v.stored_at_utc}</span>
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
                        {label}
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
                        {label}
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
                <VATimeline displayOnlyResult={lastMsaResult} storeApiBase={API_BASE} />
              </div>
            ) : (
              <p className="hint">No MSA result yet. Upload an MP4 on the Analyze tab (MSA section); you’ll be brought here to view the video and timeline.</p>
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
          {error && <p className="error">{error}</p>}
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
                  placeholder="Storing password"
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
                <p className="hint store-status">{saveStatus}</p>
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
          <p className="hint">Upload an MP4 for valence/arousal (V/A) timeline.</p>
          <VATimeline
            apiBaseUrl={VA_API_BASE}
            storeApiBase={API_BASE}
            onMsaResult={(r) => {
              setLastMsaResult(r)
              setView('msa')
            }}
          />
          <p className="hint msa-timing-hint">First run may take 1–2 minutes while the model loads; later runs are faster.</p>
        </section>
        </>
        )}
      </main>

      <footer className="footer" style={{ marginTop: '2rem', padding: '0.5rem' }} />
    </div>
  )
}

export default App
