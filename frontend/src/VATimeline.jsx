/**
 * V/A (valence/arousal) timeline: upload MP4, show video and charts.
 * Requires the V/A server running (e.g. scripts/run_va_server.bat on port 5000).
 */
import { useRef, useEffect, useState, useCallback } from 'react'
import { Chart } from 'chart.js/auto'

const WINDOW_SEC = 90
const PLAYHEAD_OFFSET = 15
const WINDOW_UPDATE_MS = 150
const Y_PADDING = 0.08
const Y_MIN_SPAN = 0.2

function buildDataset(label, times, values, borderColor) {
  const count = (times && values) ? Math.min(times.length, values.length) : 0
  const pointRadius = count <= 5 ? 5 : count <= 20 ? 3 : 0
  return {
    label,
    data: (times || []).map((t, i) => ({ x: t, y: values[i] })),
    borderColor,
    backgroundColor: borderColor + '40',
    fill: false,
    tension: 0.1,
    pointRadius,
  }
}

function yRangeForWindow(timesA, valuesA, timesB, valuesB, windowXMin, windowXMax) {
  let lo = 1, hi = -1
  function add(t, v) {
    if (t >= windowXMin && t <= windowXMax) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  }
  if (timesA && valuesA) timesA.forEach((t, i) => add(t, valuesA[i]))
  if (timesB && valuesB) timesB.forEach((t, i) => add(t, valuesB[i]))
  if (lo > hi) return { min: -1, max: 1 }
  const span = Math.max(Y_MIN_SPAN, (hi - lo) * (1 + Y_PADDING))
  const mid = (lo + hi) / 2
  return { min: mid - span / 2, max: mid + span / 2 }
}

function yRangeFromValues(values) {
  if (!Array.isArray(values) || values.length === 0) return { min: -1, max: 1 }
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = Math.max(Y_MIN_SPAN, (hi - lo) * (1 + Y_PADDING))
  const mid = (lo + hi) / 2
  return { min: mid - span / 2, max: mid + span / 2 }
}

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { labels: { color: '#ccc' } } },
  scales: {
    x: { type: 'linear', min: 0, max: WINDOW_SEC, title: { display: true, text: 'Time (s)', color: '#888' }, ticks: { color: '#888' }, grid: { color: '#333' } },
    y: { min: -1, max: 1, title: { display: true, text: 'Value', color: '#888' }, ticks: { color: '#888' }, grid: { color: '#333' } },
  },
}

const VA_QUADRANTS = [
  { key: 'high_v_low_a', label: 'High V, Low A' },
  { key: 'low_v_high_a', label: 'Low V, High A' },
  { key: 'high_v_high_a', label: 'High V, High A' },
  { key: 'low_v_low_a', label: 'Low V, Low A' },
]

function VATimelineCharts({ timelineData, duration, currentTime }) {
  const valenceCanvasRef = useRef(null)
  const arousalCanvasRef = useRef(null)
  const valenceChartRef = useRef(null)
  const arousalChartRef = useRef(null)
  useEffect(() => {
    const data = timelineData
    const timesPred = Array.isArray(data?.times_pred) ? data.times_pred : []
    const valencePred = Array.isArray(data?.valence_pred) ? data.valence_pred : []
    const arousalPred = Array.isArray(data?.arousal_pred) ? data.arousal_pred : []
    const validLength = timesPred.length > 0 && timesPred.length === valencePred.length && valencePred.length === arousalPred.length
    if (!data || !validLength) return
    const vCanvas = valenceCanvasRef.current
    const aCanvas = arousalCanvasRef.current
    if (!vCanvas || !aCanvas) return
    try {
      const xMax = Math.max(1, duration || 1, ...(timesPred.length ? timesPred : [0]))
      const vY = yRangeFromValues(valencePred)
      const aY = yRangeFromValues(arousalPred)
      if (valenceChartRef.current) valenceChartRef.current.destroy()
      valenceChartRef.current = new Chart(vCanvas, {
        type: 'line',
        data: { datasets: [buildDataset('Model', timesPred, valencePred, '#ff922b')] },
        options: {
          ...chartOptions,
          scales: {
            ...chartOptions.scales,
            x: { ...chartOptions.scales.x, min: 0, max: xMax },
            y: { ...chartOptions.scales.y, min: vY.min, max: vY.max },
          },
        },
      })
      if (arousalChartRef.current) arousalChartRef.current.destroy()
      arousalChartRef.current = new Chart(aCanvas, {
        type: 'line',
        data: { datasets: [buildDataset('Model', timesPred, arousalPred, '#ff922b')] },
        options: {
          ...chartOptions,
          scales: {
            ...chartOptions.scales,
            x: { ...chartOptions.scales.x, min: 0, max: xMax },
            y: { ...chartOptions.scales.y, min: aY.min, max: aY.max },
          },
        },
      })
    } catch (err) { console.error('Chart error:', err) }
    return () => {
      if (valenceChartRef.current) { valenceChartRef.current.destroy(); valenceChartRef.current = null }
      if (arousalChartRef.current) { arousalChartRef.current.destroy(); arousalChartRef.current = null }
    }
  }, [timelineData, duration])
  const durationSec = duration > 0 ? duration : 1
  const playheadPct = currentTime != null ? Math.max(0, Math.min(100, (currentTime / durationSec) * 100)) : null
  return (
    <>
      <div className="va-chart-label">Valence</div>
      <div className="va-chart-wrap">
        <canvas ref={valenceCanvasRef} />
        {playheadPct != null && <div className="va-playhead" style={{ left: `${playheadPct}%` }} aria-hidden="true" />}
      </div>
      <div className="va-chart-label">Arousal</div>
      <div className="va-chart-wrap">
        <canvas ref={arousalCanvasRef} />
        {playheadPct != null && <div className="va-playhead" style={{ left: `${playheadPct}%` }} aria-hidden="true" />}
      </div>
    </>
  )
}

function MSADisplayOnlyView({ result, storeApiBase }) {
  const [storePassword, setStorePassword] = useState('')
  const [storeStatus, setStoreStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const videoRef = useRef(null)
  const duration = result.duration_sec ?? 1
  const vaUploadId = result.vaUploadId ?? null
  const avgV = result.avgV ?? null
  const avgA = result.avgA ?? null

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = () => setCurrentTime(video.currentTime)
    const onSeeked = () => setCurrentTime(video.currentTime)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onSeeked)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onSeeked)
    }
  }, [result.videoUrl])

  async function handleStoreQuadrant(quadrantKey) {
    if (!storeApiBase || !vaUploadId || avgV == null || avgA == null) return
    if (!storePassword.trim()) { setStoreStatus('Enter store password'); return }
    setSaving(true)
    setStoreStatus(null)
    try {
      const res = await fetch((storeApiBase || '').replace(/\/$/, '') + '/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_password: storePassword,
          video_id: vaUploadId,
          title: 'VA upload',
          store_under_emotion: quadrantKey,
          va_average_valence: avgV,
          va_average_arousal: avgA,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || res.statusText)
      }
      const data = await res.json()
      setStoreStatus(`Stored under ${data.emotion_folder || quadrantKey}/${data.filename}`)
      setStorePassword('')
    } catch (err) {
      setStoreStatus(err.message || 'Failed to store')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="va-timeline-content va-timeline-display-only">
      <video ref={videoRef} src={result.videoUrl} controls crossOrigin="anonymous" className="va-video" />
      {avgV != null && avgA != null && (
        <div className="va-average-row">
          <span className="va-average-label">Average V: {avgV.toFixed(3)}</span>
          <span className="va-average-label">Average A: {avgA.toFixed(3)}</span>
        </div>
      )}
      {storeApiBase && vaUploadId != null && avgV != null && avgA != null && (
        <>
          <div className="va-store-row">
            <input
              type="password"
              placeholder="Store password"
              value={storePassword}
              onChange={(e) => setStorePassword(e.target.value)}
              className="input store-password-input"
              autoComplete="off"
              disabled={saving}
            />
            <span className="va-store-buttons-label">Store under:</span>
            {VA_QUADRANTS.map(({ key, label }) => (
              <button key={key} type="button" className="btn store-btn" onClick={() => handleStoreQuadrant(key)} disabled={saving}>
                {saving ? '…' : label}
              </button>
            ))}
          </div>
          {storeStatus && <p className="hint va-store-status">{storeStatus}</p>}
        </>
      )}
      <VATimelineCharts timelineData={result.timeline} duration={duration} currentTime={currentTime} />
    </div>
  )
}

export default function VATimeline({ apiBaseUrl, storeApiBase, onMsaResult, displayOnlyResult }) {
  const [uploadStatus, setUploadStatus] = useState('')
  const [statusClass, setStatusClass] = useState('')
  const [timelineData, setTimelineData] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [vaUploadId, setVaUploadId] = useState(null) // for store (e.g. va_abc123)
  const [duration, setDuration] = useState(1)
  const [storePassword, setStorePassword] = useState('')
  const [storeStatus, setStoreStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const [windowXMin, setWindowXMin] = useState(0)
  const [windowXMax, setWindowXMax] = useState(WINDOW_SEC)
  const valenceCanvasRef = useRef(null)
  const arousalCanvasRef = useRef(null)
  const valencePlayheadRef = useRef(null)
  const arousalPlayheadRef = useRef(null)
  const valenceChartRef = useRef(null)
  const arousalChartRef = useRef(null)
  const videoRef = useRef(null)
  const lastWindowUpdateRef = useRef(0)
  const abortControllerRef = useRef(null)

  const setTimeWindow = useCallback((t) => {
    const dur = duration > 0 ? duration : (timelineData ? Math.max(...(timelineData.times_pred || [0]), 1) : 1)
    let xMin = Math.max(0, t - PLAYHEAD_OFFSET)
    let xMax = Math.min(dur, xMin + WINDOW_SEC)
    if (xMax - xMin < WINDOW_SEC) xMin = Math.max(0, xMax - WINDOW_SEC)
    setWindowXMin(xMin)
    setWindowXMax(xMax)

    const vChart = valenceChartRef.current
    const aChart = arousalChartRef.current
    if (timelineData) {
      const vY = yRangeForWindow(timelineData.times_gt, timelineData.valence_gt, timelineData.times_pred, timelineData.valence_pred, xMin, xMax)
      const aY = yRangeForWindow(timelineData.times_gt, timelineData.arousal_gt, timelineData.times_pred, timelineData.arousal_pred, xMin, xMax)
      if (vChart?.options?.scales?.x) {
        vChart.options.scales.x.min = xMin
        vChart.options.scales.x.max = xMax
        vChart.options.scales.y.min = vY.min
        vChart.options.scales.y.max = vY.max
        vChart.update('none')
      }
      if (aChart?.options?.scales?.x) {
        aChart.options.scales.x.min = xMin
        aChart.options.scales.x.max = xMax
        aChart.options.scales.y.min = aY.min
        aChart.options.scales.y.max = aY.max
        aChart.update('none')
      }
    }

    const span = xMax - xMin
    const pct = span > 0 ? ((t - xMin) / span) * 100 : 0
    if (valencePlayheadRef.current) valencePlayheadRef.current.style.left = Math.max(0, Math.min(100, pct)) + '%'
    if (arousalPlayheadRef.current) arousalPlayheadRef.current.style.left = Math.max(0, Math.min(100, pct)) + '%'
  }, [duration, timelineData])

  // Build charts when timelineData is set (guarded so bad data never crashes the component)
  useEffect(() => {
    const data = timelineData
    const timesPred = Array.isArray(data?.times_pred) ? data.times_pred : []
    const valencePred = Array.isArray(data?.valence_pred) ? data.valence_pred : []
    const arousalPred = Array.isArray(data?.arousal_pred) ? data.arousal_pred : []
    const validLength = timesPred.length > 0 && timesPred.length === valencePred.length && valencePred.length === arousalPred.length
    if (!data || (!data.times_gt?.length && !validLength)) return

    const vCanvas = valenceCanvasRef.current
    const aCanvas = arousalCanvasRef.current
    if (!vCanvas || !aCanvas) return

    try {
      const totalMax = Math.max(...(data.times_gt || []), ...(timesPred.length ? timesPred : [0]), 1)
      const xMin = 0
      const xMax = Math.min(WINDOW_SEC, totalMax)

      if (valenceChartRef.current) valenceChartRef.current.destroy()
      const valenceDatasets = []
      if (data.times_gt?.length) valenceDatasets.push(buildDataset('Ground truth', data.times_gt, data.valence_gt, '#4dabf7'))
      if (validLength) valenceDatasets.push(buildDataset('Model', timesPred, valencePred, '#ff922b'))
      valenceChartRef.current = new Chart(vCanvas, {
        type: 'line',
        data: { datasets: valenceDatasets },
        options: { ...chartOptions, scales: { ...chartOptions.scales, x: { ...chartOptions.scales.x, min: xMin, max: xMax } } },
      })

      if (arousalChartRef.current) arousalChartRef.current.destroy()
      const arousalDatasets = []
      if (data.times_gt?.length) arousalDatasets.push(buildDataset('Ground truth', data.times_gt, data.arousal_gt, '#4dabf7'))
      if (validLength) arousalDatasets.push(buildDataset('Model', timesPred, arousalPred, '#ff922b'))
      arousalChartRef.current = new Chart(aCanvas, {
        type: 'line',
        data: { datasets: arousalDatasets },
        options: { ...chartOptions, scales: { ...chartOptions.scales, x: { ...chartOptions.scales.x, min: xMin, max: xMax } } },
      })

      setTimeWindow(0)
    } catch (chartErr) {
      console.error('Chart error:', chartErr)
    }
    return () => {
      if (valenceChartRef.current) { valenceChartRef.current.destroy(); valenceChartRef.current = null }
      if (arousalChartRef.current) { arousalChartRef.current.destroy(); arousalChartRef.current = null }
    }
  }, [timelineData])

  // Video timeupdate -> update window
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = () => {
      const now = Date.now()
      if (now - lastWindowUpdateRef.current >= WINDOW_UPDATE_MS) {
        lastWindowUpdateRef.current = now
        setTimeWindow(video.currentTime)
      }
    }
    const onSeeked = () => { lastWindowUpdateRef.current = 0; setTimeWindow(video.currentTime) }
    const onDurationChange = () => setDuration(video.duration || 1)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('durationchange', onDurationChange)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('durationchange', onDurationChange)
    }
  }, [videoUrl, setTimeWindow])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal
    setUploadStatus('Uploading…')
    setStatusClass('va-loading')
    setTimelineData(null)
    setVideoUrl(null)
    setStoreStatus(null)
    const form = new FormData()
    form.append('video', file)
    const base = (apiBaseUrl || '').replace(/\/$/, '')
    try {
      const r = await fetch(base + '/api/upload-stream', { method: 'POST', body: form, signal })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        const msg = j.error === 'no_file' ? 'No file selected' : j.error === 'not_mp4' ? 'Please choose an MP4 file' : (j.detail || j.error)
        setUploadStatus(msg)
        setStatusClass('va-error')
        e.target.value = ''
        return
      }
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let gotResultOrError = false

      function showError(msg) {
        gotResultOrError = true
        setTimelineData(null)
        setVideoUrl(null)
        setUploadStatus(msg || 'Inference failed')
        setStatusClass('va-error')
      }

      function applyResult(j) {
        const raw = j.timeline
        const timesPred = Array.isArray(raw?.times_pred) ? raw.times_pred : []
        const valencePred = Array.isArray(raw?.valence_pred) ? raw.valence_pred : []
        const arousalPred = Array.isArray(raw?.arousal_pred) ? raw.arousal_pred : []
        const valid = timesPred.length > 0 && timesPred.length === valencePred.length && valencePred.length === arousalPred.length
        const tl = valid ? { ...raw, times_pred: timesPred, valence_pred: valencePred, arousal_pred: arousalPred } : null
        if (!tl) {
          showError('Server returned invalid timeline (missing or mismatched V/A data).')
          return
        }
        setUploadStatus('Done. Showing V/A for: ' + file.name)
        setStatusClass('va-ok')
        setDuration(j.duration_sec ?? 1)
        setVideoUrl(base + (j.video_url || ''))
        setTimelineData(tl)
        const id = (j.video_url || '').replace(/^\/uploads\//, '').replace(/\.mp4$/i, '')
        setVaUploadId(id ? 'va_' + id : 'va_upload')
        const avgV = Array.isArray(tl?.valence_pred) && tl.valence_pred.length ? tl.valence_pred.reduce((a, b) => a + b, 0) / tl.valence_pred.length : null
        const avgA = Array.isArray(tl?.arousal_pred) && tl.arousal_pred.length ? tl.arousal_pred.reduce((a, b) => a + b, 0) / tl.arousal_pred.length : null
        const uploadId = id ? 'va_' + id : 'va_upload'
        onMsaResult?.({ videoUrl: base + (j.video_url || ''), timeline: tl, avgV, avgA, duration_sec: j.duration_sec, fileName: file.name, vaUploadId: uploadId })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const j = JSON.parse(line)
            if (j.type === 'progress') {
              setUploadStatus(j.message || '…')
            } else if (j.type === 'result') {
              gotResultOrError = true
              try { applyResult(j) } catch (e) { showError('Result error: ' + (e?.message || String(e))) }
            } else if (j.type === 'error') {
              showError(j.detail || 'Inference failed')
            }
          } catch (parseErr) {
            const trimmed = line.trim()
            if (trimmed.length > 0 && (trimmed.includes('Error') || trimmed.includes('Exception') || trimmed.includes('Traceback'))) {
              showError(trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed)
            }
          }
        }
      }
      if (buffer.trim()) {
        try {
          const j = JSON.parse(buffer)
          if (j.type === 'result') {
            gotResultOrError = true
            try { applyResult(j) } catch (e) { showError('Result error: ' + (e?.message || String(e))) }
          } else if (j.type === 'error') {
            showError(j.detail || 'Inference failed')
          }
        } catch (parseErr) {
          const trimmed = buffer.trim()
          if (trimmed.length > 0 && (trimmed.includes('Error') || trimmed.includes('Exception'))) {
            showError(trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed)
          }
        }
      }
      if (!gotResultOrError) {
        showError('No response from server. The V/A server may have crashed—check its logs.')
      }
    } catch (err) {
      setTimelineData(null)
      setVideoUrl(null)
      if (err?.name === 'AbortError') {
        setUploadStatus('Cancelled')
        setStatusClass('va-error')
      } else {
        const isNetworkError = err?.message === 'Failed to fetch' || err?.name === 'TypeError'
        setUploadStatus(isNetworkError
          ? 'Could not reach the V/A server. Run it locally (e.g. scripts\\run_va_server.bat on port 5000) or set VITE_VA_API_BASE.'
          : 'Upload failed: ' + (err?.message || String(err)))
        setStatusClass('va-error')
      }
    }
    e.target.value = ''
    abortControllerRef.current = null
  }

  function handleStopUpload() {
    abortControllerRef.current?.abort()
  }

  const vp = timelineData?.valence_pred
  const ap = timelineData?.arousal_pred
  const avgV = Array.isArray(vp) && vp.length ? vp.reduce((a, b) => a + b, 0) / vp.length : null
  const avgA = Array.isArray(ap) && ap.length ? ap.reduce((a, b) => a + b, 0) / ap.length : null

  async function handleStoreQuadrant(quadrantKey) {
    if (!storeApiBase || !vaUploadId || avgV == null || avgA == null) return
    if (!storePassword.trim()) {
      setStoreStatus('Enter store password')
      return
    }
    setSaving(true)
    setStoreStatus(null)
    try {
      const res = await fetch((storeApiBase || '').replace(/\/$/, '') + '/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_password: storePassword,
          video_id: vaUploadId,
          title: 'VA upload',
          store_under_emotion: quadrantKey,
          va_average_valence: avgV,
          va_average_arousal: avgA,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || res.statusText)
      }
      const data = await res.json()
      setStoreStatus(`Stored under ${data.emotion_folder || quadrantKey}/${data.filename}`)
      setStorePassword('')
    } catch (err) {
      setStoreStatus(err.message || 'Failed to store')
    } finally {
      setSaving(false)
    }
  }

  const displayStatus = uploadStatus && uploadStatus.trim() ? uploadStatus : 'Ready to upload'
  const isNeutral = displayStatus === 'Ready to upload'
  const isError = !isNeutral && statusClass === 'va-error'
  const statusCls = isNeutral ? '' : statusClass

  // Display-only mode: show video + charts + store from a result (e.g. on Results tab or popout)
  if (displayOnlyResult?.timeline && displayOnlyResult?.videoUrl) {
    return (
      <MSADisplayOnlyView
        result={displayOnlyResult}
        storeApiBase={storeApiBase}
      />
    )
  }

  return (
    <div className="va-timeline-content">
      <div className="va-upload-wrap">
        <label htmlFor="vaFileInput">Upload MP4</label>
        <input type="file" id="vaFileInput" accept="video/mp4" onChange={handleFileChange} className="input" disabled={statusClass === 'va-loading'} />
        {statusClass === 'va-loading' && (
          <button type="button" className="btn va-stop-btn" onClick={handleStopUpload} aria-label="Stop upload">
            Stop
          </button>
        )}
        <span id="uploadStatus" className={`va-upload-status ${statusCls}`}>{displayStatus}</span>
      </div>
      <div
        className={`va-status-block ${isError ? 'va-status-block-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {displayStatus}
      </div>
      {videoUrl && (
        <video ref={videoRef} src={videoUrl} controls crossOrigin="anonymous" className="va-video" />
      )}
      {timelineData && (
        <>
          {avgV != null && avgA != null && (
            <div className="va-average-row">
              <span className="va-average-label">Average V: {avgV.toFixed(3)}</span>
              <span className="va-average-label">Average A: {avgA.toFixed(3)}</span>
            </div>
          )}
          <div className="va-store-row">
            <input
              type="password"
              placeholder="Store password"
              value={storePassword}
              onChange={(e) => setStorePassword(e.target.value)}
              className="input store-password-input"
              autoComplete="off"
              disabled={saving}
            />
            <span className="va-store-buttons-label">Store under:</span>
            {VA_QUADRANTS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className="btn store-btn"
                onClick={() => handleStoreQuadrant(key)}
                disabled={saving}
              >
                {saving ? '…' : label}
              </button>
            ))}
          </div>
          {storeStatus && <p className="hint va-store-status">{storeStatus}</p>}
          <div className="va-chart-label">Valence</div>
          <div className="va-chart-wrap">
            <canvas ref={valenceCanvasRef} />
            <div ref={valencePlayheadRef} className="va-playhead" />
          </div>
          <div className="va-chart-label">Arousal</div>
          <div className="va-chart-wrap">
            <canvas ref={arousalCanvasRef} />
            <div ref={arousalPlayheadRef} className="va-playhead" />
          </div>
        </>
      )}
    </div>
  )
}
