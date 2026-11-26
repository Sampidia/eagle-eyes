export function _initCctvPanel() {
  if (!this._cctvPanel) return;

  this.listen(this._cctvEnableBtn, 'click', async () => {
    this._actionGeneration++;
    await this.actions.toggleEnabled();
  });

  this.listen(this._cctvNearestBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.focusNearest({ focus: false }),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.8),
    );
  });

  this.listen(this._cctvPrevBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.cycleCamera(-1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    );
  });

  this.listen(this._cctvNextBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.cycleCamera(1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    );
  });

  this.listen(this._cctvSelect, 'change', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    const cameraId = this._cctvSelect.value;
    if (!cameraId) return;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    // Picking a camera from the dropdown flies to it. The catalog spans
    // three metros, so a bare selection used to leave the view in the old
    // city with a camera active thousands of km away.
    this.actions.runExplicitFocus(
      () => (this.cctv.selectCamera(cameraId) ? cameraId : null),
      (selectedId) => this.cctv.focusCamera(selectedId, 2.2),
    );
    this.actions.setParams({ selectedCameraId: cameraId }, { origin: 'user' });
  });

  this.listen(this._cctvFocusBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    const selected = this._cctvState?.activeCameraId || this._cctvSelect?.value;
    if (!selected) return;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => selected,
      (cameraId) => this.cctv.focusCamera(cameraId, 1.9),
    );
    this.actions.setParams({ selectedCameraId: selected }, { origin: 'user' });
  });

  this.listen(this._cctvCoverageBtn, 'click', () => {
    const current =
      this._cctvState?.coverageMode ||
      (this._cctvState?.showCoverage ? 'on' : 'off');
    const next =
      current === 'off' ? 'on' : current === 'on' ? 'viewshed' : 'off';
    this.actions.setParams({ coverageMode: next }, { origin: 'user' });
  });

  this.listen(this._cctvAutoHopBtn, 'click', () => {
    const current = !!this._cctvState?.autoHop;
    this.actions.setParams({ autoHop: !current }, { origin: 'user' });
  });

  this.listen(this._cctvProjectionBtn, 'click', () => {
    const current = this._cctvState?.showProjection !== false;
    this.actions.setParams({ showProjection: !current }, { origin: 'user' });
  });

  this.listen(this._cctvAdjustBtn, 'click', () => {
    const current = !!this._cctvState?.calibrationMode;
    this.actions.setParams({ calibrationMode: !current }, { origin: 'user' });
  });

  // Click-to-edit pose readout: each chip swaps to a number input; Enter or
  // blur commits (converted to a calibration offset against basePose),
  // Escape cancels. Delegated so re-renders never re-bind.
  this.listen(this._cctvCalReadout, 'click', (event) => {
    const chip = event.target.closest?.('.cctv-cal-value');
    if (!chip || chip.disabled || chip.querySelector('input')) return;
    this._beginCctvCalValueEdit(chip);
  });

  this.listen(this._cctvCalibSaveBtn, 'click', () => {
    const cameraId = this._activeCctvCameraId();
    if (!cameraId || !this.actions.setParams) return;
    this.actions.setParams(
      {
        selectedCameraId: cameraId,
        calibration: { cameraId, save: true },
      },
      { origin: 'user' },
    );
    this.actions.showToast('CCTV calibration saved');
  });

  this.listen(this._cctvCalibResetBtn, 'click', () => {
    this._resetCctvCalibration();
  });

  // ── Live saved-frame history bindings ────────────────────────────────────
  this.listen(this._cctvFramePrev, 'click', () => this._stepLiveFrame(-1));
  this.listen(this._cctvFrameNext, 'click', () => this._stepLiveFrame(1));

  // ── Archive mode pill bindings ──────────────────────────────────────────
  this.listen(this._cctvModeLive, 'click', () => this._setArchiveMode('live'));
  this.listen(this._cctvMode24h,  'click', () => this._setArchiveMode('24h'));
  this.listen(this._cctvMode48h,  'click', () => this._setArchiveMode('48h'));

  // ── Archive video player bindings ────────────────────────────────────────
  if (this._cctvArchiveVideo) {
    // Scrubber drag — seek video to the dragged position
    this.listen(this._cctvScrubber, 'input', () => {
      const v = this._cctvArchiveVideo;
      if (!v || !isFinite(v.duration)) return;
      v.currentTime = (Number(this._cctvScrubber.value) / 100) * v.duration;
    });

    // HUD refresh + projection sync as the video plays or metadata arrives
    const syncArchiveReady = () => {
      const v = this._cctvArchiveVideo;
      if (!v || !this._archiveMode || this._archiveMode === 'live') return;
      this._cctvFrameWrap?.classList.remove('loading');
      delete this._cctvFrameWrap?.dataset?.archiveLoading;
      this._cctvFrameWrap?.classList.add('has-frame');
      v.classList.add('active');
      const cameraId = this._cctvState?.activeCameraId || '';
      if (cameraId && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('gev:cctv-archive-mode', {
            detail: {
              cameraId,
              mode: this._archiveMode,
              video: v,
              corsClean: v.crossOrigin === 'anonymous',
            },
          }),
        );
      }
    };

    this.listen(this._cctvArchiveVideo, 'timeupdate',     () => this._updateArchivePlayerHud());
    this.listen(this._cctvArchiveVideo, 'loadedmetadata', () => {
      this._updateArchivePlayerHud();
      syncArchiveReady();
    });
    this.listen(this._cctvArchiveVideo, 'loadeddata',     syncArchiveReady);
    this.listen(this._cctvArchiveVideo, 'canplay',        syncArchiveReady);
    this.listen(this._cctvArchiveVideo, 'waiting', () => {
      if (this._archiveMode && this._archiveMode !== 'live') {
        this._cctvFrameWrap?.classList.add('loading');
      }
    });

    // Play / Pause toggle button
    this.listen(this._cctvPlayBtn, 'click', () => {
      const v = this._cctvArchiveVideo;
      if (!v) return;
      v.paused ? v.play() : v.pause();
    });

    // Sync play/pause label to actual video state
    this.listen(this._cctvArchiveVideo, 'play',  () => {
      if (this._cctvPlayBtn) this._cctvPlayBtn.textContent = '⏸ PAUSE';
      syncArchiveReady();
    });
    this.listen(this._cctvArchiveVideo, 'pause', () => {
      if (this._cctvPlayBtn) this._cctvPlayBtn.textContent = '▶ PLAY';
    });
    this.listen(this._cctvArchiveVideo, 'error', () => {
      const v = this._cctvArchiveVideo;
      // If CORS mode failed before metadata, retry once without crossOrigin so panel playback still works
      if (v && v.crossOrigin === 'anonymous' && !v.dataset.corsFallbackTried && v.src) {
        v.dataset.corsFallbackTried = '1';
        v.removeAttribute('crossorigin');
        v.load();
        v.play().catch(() => {
          v.muted = true;
          v.play().catch(() => {});
        });
        return;
      }
      this._cctvFrameWrap?.classList.remove('loading');
      delete this._cctvFrameWrap?.dataset?.archiveLoading;
      if (this._archiveMode && this._archiveMode !== 'live' && this._cctvSourceBadge) {
        this._cctvSourceBadge.textContent = 'ARCHIVE · MEDIA ERROR';
        this._cctvSourceBadge.dataset.frameState = 'error';
      }
    });

    // Skip ±10 s
    this.listen(this._cctvSkipBack, 'click', () => {
      const v = this._cctvArchiveVideo;
      if (v) v.currentTime = Math.max(0, v.currentTime - 10);
    });
    this.listen(this._cctvSkipFwd, 'click', () => {
      const v = this._cctvArchiveVideo;
      if (v) v.currentTime = Math.min(isFinite(v.duration) ? v.duration : 0, v.currentTime + 10);
    });
  }

  this._renderCctvState(null);
  this.actions.syncViewport();
}

// ── Archive mode helpers ─────────────────────────────────────────────────────

function formatHMS(s) {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

/**
 * Switch between LIVE / 24H / 48H playback modes.
 * Called on `this` (a CctvControls instance).
 */
export function _setArchiveMode(mode) {
  if (this.destroyed) return;
  this._archiveMode = mode;

  // Update pill active states
  for (const [el, m] of [
    [this._cctvModeLive, 'live'],
    [this._cctvMode24h,  '24h'],
    [this._cctvMode48h,  '48h'],
  ]) {
    el?.classList.toggle('active', m === mode);
  }

  if (mode === 'live') {
    // Tear down archive player, restore live projection & re-trigger live rendering
    if (this._cctvArchiveVideo) {
      this._cctvArchiveVideo.pause();
      this._cctvArchiveVideo.classList.remove('active');
      this._cctvArchiveVideo.hidden = true;
    }
    delete this._cctvFrameWrap?.dataset?.archiveLoading;
    const cameraId = this._cctvState?.activeCameraId || '';
    if (cameraId && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('gev:cctv-archive-mode', {
          detail: { cameraId, mode: 'live', video: null, corsClean: false },
        }),
      );
    }
    if (this._cctvPlayerControls) this._cctvPlayerControls.hidden = true;
    if (this._cctvLiveControls)   this._cctvLiveControls.hidden   = false;
    // Re-run live render (restores live frame/video)
    this._renderCctvState(this._cctvState);
    this._updateLiveFrameHud?.();
  } else {
    // Hide live elements, show animated loading shimmer until archive video is ready
    if (this._cctvFrame) this._cctvFrame.hidden = true;
    if (this._cctvVideo) this._cctvVideo.hidden = true;
    if (this._cctvFrameWrap) {
      this._cctvFrameWrap.classList.remove('has-frame');
      this._cctvFrameWrap.classList.add('loading');
      this._cctvFrameWrap.dataset.archiveLoading = 'true';
    }
    if (this._cctvLiveControls)   this._cctvLiveControls.hidden   = true;
    if (this._cctvPlayerControls) this._cctvPlayerControls.hidden = false;
    if (this._cctvPlayBtn) this._cctvPlayBtn.textContent = '▶ PLAY';

    const activeCamera = this._cctvState?.activeCamera;
    const archiveUrl =
      mode === '24h' ? activeCamera?.archives?.url24h
                     : activeCamera?.archives?.url48h;
    const v = this._cctvArchiveVideo;
    if (v && archiveUrl) {
      v.classList.remove('active');
      delete v.dataset.corsFallbackTried;
      v.crossOrigin = 'anonymous';
      v.src    = archiveUrl;
      v.hidden = false;
      v.load();
      v.play().catch(() => {
        // Retry muted if browser autoplay policy blocks unmuted playback
        v.muted = true;
        v.play().catch(() => {});
      });
    } else if (v) {
      this._cctvFrameWrap?.classList.remove('loading');
      delete this._cctvFrameWrap?.dataset?.archiveLoading;
      v.hidden = false; // show element even without URL (shows native error state)
    }
  }
}

/**
 * Refresh scrubber position and time labels while archive video plays.
 * Called on `this` (a CctvControls instance).
 */
export function _updateArchivePlayerHud() {
  const v = this._cctvArchiveVideo;
  if (!v) return;
  const cur = isFinite(v.currentTime) ? v.currentTime : 0;
  const dur = isFinite(v.duration)    ? v.duration    : 0;
  if (this._cctvTimeElapsed) this._cctvTimeElapsed.textContent = formatHMS(cur);
  if (this._cctvTimeTotal)   this._cctvTimeTotal.textContent   = formatHMS(dur);
  if (this._cctvScrubber && dur > 0) {
    this._cctvScrubber.value = String((cur / dur) * 100);
  }
}

/**
 * Step backward (-1) or forward (+1) through saved live frames in memory.
 * Called on `this` (a CctvControls instance).
 */
export function _stepLiveFrame(delta) {
  if (this.destroyed) return;
  const cameraId = this._cctvState?.activeCameraId || this._cctvFrame?.dataset?.cameraId || '';
  const history = cameraId ? this._liveFrameHistory?.get(cameraId) : null;
  if (!history || history.length === 0) return;

  const currentIdx =
    this._liveHistoryIndex >= 0 && this._liveHistoryIndex < history.length
      ? this._liveHistoryIndex
      : history.length - 1;

  const nextIdx = Math.max(0, Math.min(history.length - 1, currentIdx + delta));
  // If we reached the latest frame, return to auto-follow (-1)
  this._liveHistoryIndex = nextIdx === history.length - 1 ? -1 : nextIdx;

  const entry = history[nextIdx];
  if (this._cctvFrame && entry) {
    const frameSrc = entry.dataUrl || entry.src;
    this._cctvFrame.src = frameSrc;
    this._cctvFrame.classList.add('active');
    this._cctvFrameWrap?.classList.add('has-frame');
    if (typeof window !== 'undefined' && frameSrc) {
      const syncImg = new Image();
      syncImg.onload = () => {
        if (this.destroyed) return;
        window.dispatchEvent(
          new CustomEvent('gev:cctv-frame-settled', {
            detail: { cameraId, image: syncImg, src: entry.src },
          }),
        );
      };
      syncImg.src = frameSrc;
    }
  }
  this._updateLiveFrameHud();
}

/**
 * Update PREV / NEXT button states and counter for saved live frames.
 * NEXT is unclickable (disabled) whenever the latest frame is on display.
 * Called on `this` (a CctvControls instance).
 */
export function _updateLiveFrameHud() {
  const enabled = !!this._cctvState?.enabled && !!this.actions.isEnabled();
  const cameraId = this._cctvState?.activeCameraId || this._cctvFrame?.dataset?.cameraId || '';
  const history = enabled && cameraId ? this._liveFrameHistory?.get(cameraId) : null;
  const total = history?.length || 0;

  if (!enabled || total === 0) {
    if (this._cctvFramePrev) this._cctvFramePrev.disabled = true;
    if (this._cctvFrameNext) this._cctvFrameNext.disabled = true;
    if (this._cctvFrameCounter) this._cctvFrameCounter.textContent = 'LIVE';
    return;
  }

  const idx =
    this._liveHistoryIndex >= 0 && this._liveHistoryIndex < total
      ? this._liveHistoryIndex
      : total - 1;
  const isLatest = idx >= total - 1;

  if (this._cctvFramePrev) this._cctvFramePrev.disabled = idx <= 0;
  if (this._cctvFrameNext) this._cctvFrameNext.disabled = isLatest;

  if (this._cctvFrameCounter) {
    if (isLatest) {
      this._cctvFrameCounter.textContent = 'LIVE';
    } else {
      this._cctvFrameCounter.textContent = `${idx + 1}/${total}`;
    }
  }
}
