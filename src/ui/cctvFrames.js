export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

const MAX_SAVED_FRAMES_PER_CAM = 30;

function captureImageDataUrl(img) {
  try {
    const w = img?.naturalWidth || 0;
    const h = img?.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

export function _settleCctvFrame(token, src, ok) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  const loadedImage = this._cctvFramePreloader;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';

  // Save frame into browser memory ring buffer for this camera
  const cameraId = this._cctvFrame.dataset.cameraId || '';
  if (cameraId && this._liveFrameHistory) {
    let history = this._liveFrameHistory.get(cameraId);
    if (!history) {
      history = [];
      this._liveFrameHistory.set(cameraId, history);
    }
    const last = history[history.length - 1];
    if (!last || last.src !== src) {
      const dataUrl = captureImageDataUrl(loadedImage);
      history.push({
        src,
        dataUrl: dataUrl || src,
        timestamp: Date.now(),
      });
      if (history.length > MAX_SAVED_FRAMES_PER_CAM) {
        const dropped = history.length - MAX_SAVED_FRAMES_PER_CAM;
        history.splice(0, dropped);
        if (this._liveHistoryIndex >= 0) {
          this._liveHistoryIndex = Math.max(0, this._liveHistoryIndex - dropped);
        }
      }
    }
  }

  // Sync the map's ambient card & 3D projection with this exact settled frame
  if (cameraId && loadedImage && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('gev:cctv-frame-settled', {
        detail: { cameraId, image: loadedImage, src },
      }),
    );
  }

  // Only update visible <img> if user is following live (not stepped back in history)
  const history = cameraId ? this._liveFrameHistory?.get(cameraId) : null;
  const viewingOlder =
    this._liveHistoryIndex >= 0 &&
    history &&
    this._liveHistoryIndex < history.length - 1;

  if (!viewingOlder) {
    this._liveHistoryIndex = -1;
    const latestEntry = history?.[history.length - 1];
    this._cctvFrame.src = latestEntry?.dataUrl || src;
    this._cctvFrame.classList.add('active');
    this._cctvFrameWrap?.classList.add('has-frame');
  }

  this._updateLiveFrameHud?.();
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
