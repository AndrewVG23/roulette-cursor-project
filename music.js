/* Shared night-drive background music — free type beats, looping playlist. */
(function () {
  const TRACKS = [
    'assets/music-umbra.mp3',
    'assets/music-bulletz.mp3',
    'assets/music-rayo.mp3',
    'assets/music-neon.mp3',
    'assets/music-underbound.mp3',
    'assets/music-citizen.mp3',
    'assets/music-madness.mp3',
    'assets/music-oxygen.mp3',
    'assets/music-savage.mp3',
    'assets/music-venom.mp3',
    'assets/music-sniper.mp3'
  ];
  const TITLES = [
    'Umbra',
    'Bulletz',
    'Rayo',
    'Neon',
    'Underbound',
    'Citizen',
    'Madness',
    'Oxygen',
    'Savage',
    'Venom',
    'Sniper'
  ];
  const MUTE_KEY = 'cfc-bgm-muted';
  const TRACK_KEY = 'cfc-bgm-track';
  const TIME_KEY = 'cfc-bgm-time';
  const VOL = 0.3;

  let audio = null;
  let idx = 0;
  let started = false;
  let muted = false;
  let resumeAt = 0;
  const listeners = [];
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { /* ignore */ }

  function pickRandom() {
    return Math.floor(Math.random() * TRACKS.length);
  }

  function loadPersisted() {
    try {
      const saved = parseInt(localStorage.getItem(TRACK_KEY), 10);
      if (Number.isFinite(saved) && saved >= 0 && saved < TRACKS.length) {
        idx = saved;
      } else {
        idx = pickRandom();
      }
      const t = parseFloat(localStorage.getItem(TIME_KEY));
      resumeAt = Number.isFinite(t) && t > 0 ? t : 0;
    } catch (_) {
      idx = pickRandom();
      resumeAt = 0;
    }
  }

  loadPersisted();

  function persist() {
    try {
      localStorage.setItem(TRACK_KEY, String(idx));
      if (audio && Number.isFinite(audio.currentTime)) {
        localStorage.setItem(TIME_KEY, String(audio.currentTime));
      }
    } catch (_) { /* ignore */ }
  }

  function currentTitle() {
    return TITLES[idx] || 'Night Drive';
  }

  function notify() {
    const title = currentTitle();
    for (const fn of listeners) {
      try { fn(title, idx); } catch (_) { /* ignore */ }
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function applyResumeTime(a) {
    if (!(resumeAt > 0)) return;
    const t = resumeAt;
    resumeAt = 0;
    const seek = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) {
        a.currentTime = Math.min(t, Math.max(0, a.duration - 0.5));
      } else {
        a.currentTime = t;
      }
    };
    if (a.readyState >= 1) seek();
    else a.addEventListener('loadedmetadata', seek, { once: true });
  }

  function ensure() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.loop = false;
    audio.volume = VOL;
    audio.addEventListener('ended', () => {
      idx = pickRandom();
      resumeAt = 0;
      try { localStorage.setItem(TIME_KEY, '0'); } catch (_) { /* ignore */ }
      audio.src = TRACKS[idx];
      persist();
      notify();
      if (!muted) audio.play().catch(() => {});
    });
    audio.addEventListener('timeupdate', () => {
      if (started && !audio.paused) persist();
    });
    return audio;
  }

  function play() {
    if (muted) return;
    const a = ensure();
    if (!a.src || !a.getAttribute('src')) {
      a.src = TRACKS[idx];
      applyResumeTime(a);
    }
    started = true;
    persist();
    notify();
    a.play().catch(() => {});
  }

  /** Keep the current song across scene changes — only resume playback. */
  function nextScene() {
    play();
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) { /* ignore */ }
    const a = ensure();
    if (muted) {
      persist();
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
    if (document.hidden) {
      persist();
      audio.pause();
    } else if (!muted) {
      audio.play().catch(() => {});
    }
  });
  window.addEventListener('pagehide', persist);

  window.BGM = { play, nextScene, setMuted, toggleMute, isMuted, currentTitle, onChange };
})();
