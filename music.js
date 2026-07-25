/* Shared night-drive background music — both free type beats, looping. */
(function () {
  const TRACKS = [
    'assets/music-umbra.mp3',
    'assets/music-bulletz.mp3'
  ];
  const STORAGE_KEY = 'cfc-bgm-muted';
  const VOL = 0.3;

  let audio = null;
  let idx = Math.floor(Math.random() * TRACKS.length);
  let started = false;
  let muted = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { /* ignore */ }

  function ensure() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.loop = false;
    audio.volume = VOL;
    audio.addEventListener('ended', () => {
      idx = (idx + 1) % TRACKS.length;
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

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch (_) { /* ignore */ }
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

  window.BGM = { play, setMuted, toggleMute, isMuted };
})();
