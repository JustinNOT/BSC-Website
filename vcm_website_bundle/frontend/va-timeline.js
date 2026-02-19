/**
 * V/A timeline – drop into your VCM website (use with app.js).
 * Requires Chart.js: https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
 *
 * Usage from app.js:
 *   VATimeline.init({
 *     apiBaseUrl: 'http://localhost:5000',
 *     videoElId: 'video',
 *     fileInputId: 'vaFileInput',
 *     valenceChartCanvasId: 'valenceChart',
 *     arousalChartCanvasId: 'arousalChart',
 *     uploadStatusElId: 'uploadStatus'
 *   });
 */
(function (global) {
  const WINDOW_SEC = 90;
  const PLAYHEAD_OFFSET = 15;
  const WINDOW_UPDATE_MS = 150;
  const Y_PADDING = 0.08;
  const Y_MIN_SPAN = 0.2;

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { labels: { color: '#ccc' } } },
    scales: {
      x: { type: 'linear', min: 0, max: WINDOW_SEC, title: { display: true, text: 'Time (s)', color: '#888' }, ticks: { color: '#888' }, grid: { color: '#333' } },
      y: { min: -1, max: 1, title: { display: true, text: 'Value', color: '#888' }, ticks: { color: '#888' }, grid: { color: '#333' } }
    }
  };

  function buildDataset(label, times, values, borderColor) {
    const count = (times && values) ? Math.min(times.length, values.length) : 0;
    const pointRadius = count <= 5 ? 5 : count <= 20 ? 3 : 0;
    return { label, data: times.map((t, i) => ({ x: t, y: values[i] })), borderColor, backgroundColor: borderColor + '40', fill: false, tension: 0.1, pointRadius };
  }

  function yRangeForWindow(timesA, valuesA, timesB, valuesB, windowXMin, windowXMax) {
    let lo = 1, hi = -1;
    function add(t, v) {
      if (t >= windowXMin && t <= windowXMax) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    if (timesA && valuesA) timesA.forEach((t, i) => add(t, valuesA[i]));
    if (timesB && valuesB) timesB.forEach((t, i) => add(t, valuesB[i]));
    if (lo > hi) return { min: -1, max: 1 };
    const span = Math.max(Y_MIN_SPAN, (hi - lo) * (1 + Y_PADDING));
    const mid = (lo + hi) / 2;
    return { min: mid - span / 2, max: mid + span / 2 };
  }

  let valenceChart, arousalChart;
  let duration = 1;
  let timelineData = null;
  let windowXMin = 0, windowXMax = WINDOW_SEC;
  let lastWindowUpdate = 0;
  let opts = {};

  function setTimeWindow(t) {
    const dur = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : (timelineData ? Math.max(...(timelineData.times_gt || []), ...(timelineData.times_pred || [0]), 1) : 1);
    windowXMin = Math.max(0, t - PLAYHEAD_OFFSET);
    windowXMax = Math.min(dur, windowXMin + WINDOW_SEC);
    if (windowXMax - windowXMin < WINDOW_SEC) windowXMin = Math.max(0, windowXMax - WINDOW_SEC);

    if (valenceChart && valenceChart.options.scales.x) {
      valenceChart.options.scales.x.min = windowXMin;
      valenceChart.options.scales.x.max = windowXMax;
      const yr = timelineData ? yRangeForWindow(timelineData.times_gt, timelineData.valence_gt, timelineData.times_pred, timelineData.valence_pred, windowXMin, windowXMax) : { min: -1, max: 1 };
      valenceChart.options.scales.y.min = yr.min;
      valenceChart.options.scales.y.max = yr.max;
      valenceChart.update('none');
    }
    if (arousalChart && arousalChart.options.scales.x) {
      arousalChart.options.scales.x.min = windowXMin;
      arousalChart.options.scales.x.max = windowXMax;
      const yr = timelineData ? yRangeForWindow(timelineData.times_gt, timelineData.arousal_gt, timelineData.times_pred, timelineData.arousal_pred, windowXMin, windowXMax) : { min: -1, max: 1 };
      arousalChart.options.scales.y.min = yr.min;
      arousalChart.options.scales.y.max = yr.max;
      arousalChart.update('none');
    }

    const span = windowXMax - windowXMin;
    const pct = span > 0 ? ((t - windowXMin) / span) * 100 : 0;
    const vPlay = document.getElementById(opts.valencePlayheadId);
    const aPlay = document.getElementById(opts.arousalPlayheadId);
    if (vPlay) vPlay.style.left = Math.max(0, Math.min(100, pct)) + '%';
    if (aPlay) aPlay.style.left = Math.max(0, Math.min(100, pct)) + '%';
  }

  function updateCharts(data) {
    if (!data || (!data.times_gt && !data.times_pred)) return;
    timelineData = data;
    const totalMax = Math.max(...(data.times_gt || []), ...(data.times_pred || [0]), 1);
    windowXMin = 0;
    windowXMax = Math.min(WINDOW_SEC, totalMax);

    const Chart = global.Chart;
    if (!Chart) return;

    const valenceDatasets = [];
    if (data.times_gt && data.times_gt.length) valenceDatasets.push(buildDataset('Ground truth', data.times_gt, data.valence_gt, '#4dabf7'));
    valenceDatasets.push(buildDataset('Model', data.times_pred || [], data.valence_pred || [], '#ff922b'));
    const vCanvas = document.getElementById(opts.valenceChartCanvasId);
    if (vCanvas) {
      if (valenceChart) valenceChart.destroy();
      valenceChart = new Chart(vCanvas, {
        type: 'line',
        data: { datasets: valenceDatasets },
        options: { ...chartOptions, scales: { ...chartOptions.scales, x: { ...chartOptions.scales.x, min: windowXMin, max: windowXMax } } }
      });
    }

    const arousalDatasets = [];
    if (data.times_gt && data.times_gt.length) arousalDatasets.push(buildDataset('Ground truth', data.times_gt, data.arousal_gt, '#4dabf7'));
    arousalDatasets.push(buildDataset('Model', data.times_pred || [], data.arousal_pred || [], '#ff922b'));
    const aCanvas = document.getElementById(opts.arousalChartCanvasId);
    if (aCanvas) {
      if (arousalChart) arousalChart.destroy();
      arousalChart = new Chart(aCanvas, {
        type: 'line',
        data: { datasets: arousalDatasets },
        options: { ...chartOptions, scales: { ...chartOptions.scales, x: { ...chartOptions.scales.x, min: windowXMin, max: windowXMax } } }
      });
    }
    setTimeWindow(0);
  }

  function onVideoTime(t) {
    const now = Date.now();
    if (now - lastWindowUpdate >= WINDOW_UPDATE_MS) {
      lastWindowUpdate = now;
      setTimeWindow(t);
    }
  }

  function init(options) {
    opts = {
      apiBaseUrl: options.apiBaseUrl || '',
      videoElId: options.videoElId || 'video',
      fileInputId: options.fileInputId || 'vaFileInput',
      valenceChartCanvasId: options.valenceChartCanvasId || 'valenceChart',
      arousalChartCanvasId: options.arousalChartCanvasId || 'arousalChart',
      valencePlayheadId: options.valencePlayheadId || 'valencePlayhead',
      arousalPlayheadId: options.arousalPlayheadId || 'arousalPlayhead',
      uploadStatusElId: options.uploadStatusElId || 'uploadStatus'
    };

    const videoEl = document.getElementById(opts.videoElId);
    const fileInput = document.getElementById(opts.fileInputId);
    const uploadStatus = document.getElementById(opts.uploadStatusElId);

    if (videoEl) {
      videoEl.addEventListener('timeupdate', () => onVideoTime(videoEl.currentTime));
      videoEl.addEventListener('seeked', () => { lastWindowUpdate = 0; setTimeWindow(videoEl.currentTime); });
      videoEl.ondurationchange = () => { duration = videoEl.duration || 1; setTimeWindow(videoEl.currentTime); };
    }

    if (fileInput && uploadStatus) {
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        uploadStatus.textContent = 'Uploading & running model…';
        if (uploadStatus.classList) uploadStatus.classList.add('va-loading');
        const form = new FormData();
        form.append('video', file);
        try {
          const r = await fetch(opts.apiBaseUrl + '/api/upload', { method: 'POST', body: form });
          const j = await r.json();
          if (!r.ok) {
            uploadStatus.textContent = j.error === 'no_file' ? 'No file selected' : j.error === 'not_mp4' ? 'Please choose an MP4 file' : (j.detail || j.error);
            if (uploadStatus.classList) uploadStatus.classList.add('va-error');
            return;
          }
          uploadStatus.textContent = 'Done. Showing V/A for: ' + file.name;
          if (uploadStatus.classList) { uploadStatus.classList.remove('va-loading', 'va-error'); uploadStatus.classList.add('va-ok'); }
          duration = j.duration_sec || 1;
          if (videoEl) {
            videoEl.src = opts.apiBaseUrl + j.video_url;
            videoEl.ondurationchange = () => { duration = videoEl.duration || 1; setTimeWindow(videoEl.currentTime); };
          }
          updateCharts(j.timeline);
          setTimeWindow(0);
        } catch (e) {
          uploadStatus.textContent = 'Upload failed: ' + e.message;
          if (uploadStatus.classList) uploadStatus.classList.add('va-error');
        }
        fileInput.value = '';
      });
    }

    return { updateCharts, setTimeWindow };
  }

  global.VATimeline = { init, updateCharts, setTimeWindow };
})(typeof window !== 'undefined' ? window : this);
