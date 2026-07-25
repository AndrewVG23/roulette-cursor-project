/* Shared night-drive background music — free type beats, looping playlist. */
(function () {
  const TRACKS = [
    'assets/music-umbra.mp3',
    'assets/music-bulletz.mp3',
    'assets/music-rayo.mp3',
    'assets/music-neon.mp3',
    'assets/music-underbound.mp3'
  ];
  const MUTE_KEY = 'cfc-bgm-muted';
  const LAST_KEY = 'cfc-bgm-last';
  const VOL = 0.3;

  let audio = null;
  let idx = 0;
  let started = false;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { /* ignore */ }

  function pickRandom() {
    let last = -1;
    try {
      const raw = localStorage.getItem(LAST_KEY);
      if (raw != null) last = parseInt(raw, 10);
    } catch (_) { /* ignore */ }
    if (!Number.isFinite(last)) last = -1;

    let next;
    if (TRACKS.length <= 1) {
      next = 0;
    } else {
      next = Math.floor(Math.random() * TRACKS.length);
      if (next === last) next = (next + 1) % TRACKS.length;
    }
    try { localStorage.setItem(LAST_KEY, String(next)); } catch (_) { /* ignore */ }
    return next;
  }

  // New page / scene → new random track (not the one that just finished).
  idx = pickRandom();

  function ensure() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.loop = false;
    audio.volume = VOL;
    audio.addEventListener('ended', () => {
      idx = pickRandom();
      audio.src = TRACKS[idx];
      if (!muted) audio.play().catch(() => {});
    });
    return audio;
  }

  function play() {
    if (muted) return;
    const a = ensure();
    if (!a.src) a.src = TRACKS[idx];
    started = true;
    a.play().catch(() => {});
  }

  /** Force a new random song — call when entering a scene mid-session. */
  function nextScene() {
    idx = pickRandom();
    const a = ensure();
    a.src = TRACKS[idx];
    started = true;
    if (!muted) a.play().catch(() => {});
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) { /* ignore */ }
    const a = ensure();
    if (muted) {
      a.pause();
    } else if (started) {
      a.play().catch(() => {});
    }
  }

  function toggleMute() {
    setMuted(!muted);
    return muted;
  }

  function isMuted() {
    return muted;
  }

  document.addEventListener('pointerdown', () => {
    if (!started && !muted) play();
  }, { once: true });
  document.addEventListener('keydown', () => {
    if (!started && !muted) play();
  }, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!audio || !started) return;
    if (document.hidden) audio.pause();
    else if (!muted) audio.play().catch(() => {});
  });

  window.BGM = { play, nextScene, setMuted, toggleMute, isMuted };
})();
