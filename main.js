(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const yr = document.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();

  const nav = document.querySelector('[data-nav]');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  if (reduce) return;

  const reveals = Array.from(document.querySelectorAll('[data-reveal]'));
  const showAll = () => reveals.forEach((el) => el.classList.add('in'));

  if (!reveals.length) {
    // nothing to do
  } else if (!('IntersectionObserver' in window)) {
    showAll();
  } else {
    const vh = window.innerHeight;
    const pending = [];
    reveals.forEach((el, i) => {
      el.style.setProperty('--reveal-delay', (i % 5) * 60 + 'ms');
      const r = el.getBoundingClientRect();
      if (r.top < vh && r.bottom > 0) {
        // already in viewport — show synchronously, no observer round-trip
        el.classList.add('in');
      } else {
        pending.push(el);
      }
    });
    if (pending.length) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
      pending.forEach((el) => io.observe(el));
    }
    // safety net: if anything is still hidden after 1.5s, force-show
    setTimeout(showAll, 1500);
  }

  const hero = document.querySelector('.hero');
  if (hero && matchMedia('(pointer: fine)').matches) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
      hero.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
    });
  }

  if (matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty('--tx', x.toFixed(3));
        card.style.setProperty('--ty', y.toFixed(3));
      });
      card.addEventListener('pointerleave', () => {
        card.style.setProperty('--tx', 0);
        card.style.setProperty('--ty', 0);
      });
    });
  }
})();
