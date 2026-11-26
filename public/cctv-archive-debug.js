(function () {
  const RAW_IMAGEKIT_MP4 =
    'https://ik.imagekit.io/raer0lizo/Temp-files-for-buffer-upload/Ayra%20Starr,%20Rema%20-%20Who_s%20Dat%20Girl.mp4';

  const btnFetch = document.getElementById('btn-fetch-sources');
  const btn24h = document.getElementById('btn-play-24h');
  const btn48h = document.getElementById('btn-play-48h');
  const btnRaw48 = document.getElementById('btn-play-raw48');
  const btnCustom = document.getElementById('btn-play-custom');
  const btnClear = document.getElementById('btn-clear-log');
  const customInput = document.getElementById('custom-url');
  const video = document.getElementById('debug-video');
  const stats = document.getElementById('video-stats');
  const apiOutput = document.getElementById('api-output');
  const logEl = document.getElementById('log');

  let apiArchives = null;

  const MEDIA_ERROR_NAMES = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
  };

  function log(msg, cls = '') {
    const ts = new Date().toISOString().slice(11, 23);
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = `[${ts}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateStats() {
    stats.textContent =
      `readyState=${video.readyState} networkState=${video.networkState} ` +
      `size=${video.videoWidth}x${video.videoHeight} ` +
      `duration=${Number.isFinite(video.duration) ? video.duration.toFixed(2) + 's' : 'N/A'} ` +
      `paused=${video.paused} muted=${video.muted}`;
  }

  async function probeUrl(url) {
    log(`Probing headers (Range: bytes=0-1): ${url}`);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1' },
      });
      log(
        `Probe HTTP ${res.status} | content-type=${res.headers.get('content-type')} | ` +
          `content-range=${res.headers.get('content-range')} | ` +
          `accept-ranges=${res.headers.get('accept-ranges')}`,
        res.ok ? 'ok' : 'err',
      );
    } catch (err) {
      log(`Probe fetch failed (likely CORS, which does NOT block <video> without crossorigin): ${err.message}`, 'muted');
    }
  }

  function playUrl(label, url) {
    if (!url) {
      log(`${label}: URL is empty/null`, 'err');
      return;
    }
    log(`--- Loading [${label}]: ${url}`);
    customInput.value = url;
    probeUrl(url);
    video.src = url;
    video.play().then(
      () => log(`${label}: play() resolved`, 'ok'),
      (err) => {
        if (err.name === 'AbortError') return;
        log(`${label}: play() rejected (${err.name}: ${err.message}) — retrying muted`, 'err');
        video.muted = true;
        video.play().then(
          () => log(`${label}: muted play() resolved`, 'ok'),
          (err2) => log(`${label}: muted play() also rejected (${err2.name}: ${err2.message})`, 'err'),
        );
      },
    );
  }

  async function fetchSources() {
    log('Fetching /api/cctv/sources ...');
    try {
      const res = await fetch('/api/cctv/sources', { cache: 'no-store' });
      const data = await res.json();
      const list = data.sources || data.cameras || [];
      const austin6 = list.find((c) => c.id === 'austin:6');
      const withArchives = list.filter((c) => c.archives?.has24h || c.archives?.has48h);
      apiArchives = austin6?.archives || null;

      apiOutput.textContent = JSON.stringify(
        {
          httpStatus: res.status,
          cacheHeader: res.headers.get('X-GEV-Cache'),
          totalCameras: list.length,
          camerasWithArchives: withArchives.map((c) => ({ id: c.id, archives: c.archives })),
          austin6Archives: apiArchives,
        },
        null,
        2,
      );

      btn24h.disabled = !apiArchives?.url24h;
      btn48h.disabled = !apiArchives?.url48h;
      log(
        `austin:6 archives => has24h=${Boolean(apiArchives?.has24h)} has48h=${Boolean(apiArchives?.has48h)}`,
        apiArchives?.has48h ? 'ok' : 'err',
      );
    } catch (err) {
      log(`Failed to fetch /api/cctv/sources: ${err.message}`, 'err');
      apiOutput.textContent = String(err);
    }
  }

  for (const evt of [
    'loadstart',
    'durationchange',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'canplaythrough',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'suspend',
    'ended',
  ]) {
    video.addEventListener(evt, () => {
      updateStats();
      log(`video:${evt} | ${stats.textContent}`, evt === 'playing' || evt === 'canplay' ? 'ok' : '');
    });
  }

  video.addEventListener('error', () => {
    updateStats();
    const err = video.error;
    const codeName = err ? MEDIA_ERROR_NAMES[err.code] || `CODE_${err.code}` : 'UNKNOWN';
    log(`video:error | ${codeName} | message="${err?.message || ''}" | src="${video.currentSrc}"`, 'err');
  });

  btnFetch.addEventListener('click', fetchSources);
  btn24h.addEventListener('click', () => playUrl('API 24H', apiArchives?.url24h));
  btn48h.addEventListener('click', () => playUrl('API 48H', apiArchives?.url48h));
  btnRaw48.addEventListener('click', () => playUrl('Direct ImageKit MP4', RAW_IMAGEKIT_MP4));
  btnCustom.addEventListener('click', () => playUrl('Custom URL', customInput.value.trim()));
  btnClear.addEventListener('click', () => {
    logEl.innerHTML = '';
  });

  fetchSources();
})();

