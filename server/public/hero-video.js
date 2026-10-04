'use strict';
/* The moving picture behind the Overview banner (and the About banner): a short looping clip of a dew-covered plant.
   It is decoration only. It never plays sound, pauses when it is off screen, is not started for people who asked their system for less motion
   or for data saving (they see its still frame), and if it cannot play at all it removes itself so the vector art underneath shows instead. */
(function () {
  window.heroVideoHtml = function heroVideoHtml() {
    return '<video class="hero-video" muted loop playsinline autoplay preload="metadata" poster="media/hero-poster.jpg" aria-hidden="true" tabindex="-1" disablepictureinpicture disableremoteplayback>' +
      '<source src="media/hero.mp4" type="video/mp4"></video>';
  };

  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const saveData = () => { try { return !!(navigator.connection && navigator.connection.saveData); } catch (e) { return false; } };
  const watcher = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const e of entries) { const v = e.target; v.__inview = e.isIntersecting; if (v.__still) continue; if (e.isIntersecting) v.play().catch(() => { }); else v.pause(); }
  }, { threshold: 0.05 }) : null;

  function start(v) {
    if (v.__hero) return; v.__hero = true;
    v.muted = true;                                             // some browsers only honour the attribute at creation: make sure
    const gone = () => v.remove();                              // nothing to play: the banner falls back to its vector art
    const src = v.querySelector('source'); if (src) src.addEventListener('error', gone);
    v.addEventListener('error', gone);
    if (reduced() || saveData()) { v.__still = true; v.removeAttribute('autoplay'); v.preload = 'none'; v.pause(); return; }
    watcher ? watcher.observe(v) : v.play().catch(() => { });
  }
  // A tab that was in the background starts playing again when it is brought forward.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; document.querySelectorAll('video.hero-video').forEach(v => { if (!v.__still && v.__inview !== false) v.play().catch(() => { }); }); });
  const scan = root => (root.querySelectorAll ? root : document).querySelectorAll('video.hero-video').forEach(start);
  // The console redraws its pages from text: start any banner video that appears.
  new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches('video.hero-video')) start(n); else if (n.querySelector) scan(n); } })
    .observe(document.documentElement, { childList: true, subtree: true });
  scan(document);
})();
