import { useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.DEV ? '' : '' // proxy in dev

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

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
              if (obj.type === 'result') setResult(obj.data)
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
          if (obj.type === 'result') setResult(obj.data)
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

  return (
    <div className="app">
      <header className="header">
        <h1>BSC Research</h1>
        <p className="tagline">Brain Stimuli Curation — Viewers Comments Model (VCM)</p>
      </header>

      <main className="main">
        <section className="card input-section">
          <h2>Analyze a YouTube video</h2>
          <p className="hint">Paste a YouTube URL. We fetch comments, run each through the emotion model, then show the percentage of each emotion and the most prominent one. (Requires YouTube API key on the server.)</p>
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
              {result.video_emotion != null || result.emotion_percentages || result.stage2_emotion ? (
                <div className="final-emotion-box">
                  <span className="final-emotion-label">Video emotion</span>
                  {result.video_emotion != null && (
                    <p className="prominent-emotion">
                      Most prominent (from counts): <span className={`emotion-badge emotion-${result.video_emotion} final-emotion-badge`}>{result.video_emotion}</span>
                    </p>
                  )}
                  <p className="prominent-emotion stage2-row">
                    Stage 2 model (RF) dominant:{' '}
                    {result.stage2_emotion != null ? (
                      <span className={`emotion-badge emotion-${result.stage2_emotion} final-emotion-badge`}>{result.stage2_emotion}</span>
                    ) : (
                      <span className="stage2-unavailable">—</span>
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

        <section className="card msa-placeholder">
          <h2>MSA (Liris Accede)</h2>
          <p className="coming-soon">Coming soon — multimodal sentiment analysis will be integrated here.</p>
        </section>
      </main>

      <footer className="footer">
        <p>VCM model: SVMPlus pipeline · Accuracy ~68% on test set</p>
      </footer>
    </div>
  )
}

export default App
