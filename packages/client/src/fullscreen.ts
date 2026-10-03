/**
 * A fullscreen toggle on every page (the whole page goes fullscreen, its overlays and all): the
 * page's own #fullscreen button if it has one (the game's, beside the mode), else one put in its
 * [data-fullscreen-slot] (a header), else one in the bottom right corner. None where the browser
 * can't go fullscreen.
 */
const ICONS = {
  enter: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"/></svg>',
  leave: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 1v4H1M13 5H9V1M9 13V9h4M1 9h4v4"/></svg>',
};

const STYLE = `
  .fs-button { width: 28px; height: 25px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; color: #e6e6e6; background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; }
  .fs-button:hover { background: rgba(0, 0, 0, 0.75); border-color: rgba(255, 255, 255, 0.3); }
  .fs-button.corner { position: fixed; right: 12px; bottom: 12px; z-index: 1000; }
  [data-fullscreen-slot] .fs-button { vertical-align: middle; }
`;

function addFullscreenButton(): void {
  if (!document.fullscreenEnabled) return;
  let button = document.getElementById('fullscreen') as HTMLButtonElement | null;
  if (!button) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'fs-button';
    const slot = document.querySelector('[data-fullscreen-slot]');
    if (slot) slot.append(button);
    else {
      button.classList.add('corner');
      document.body.append(button);
    }
  }
  const b = button;
  b.hidden = false;
  const show = () => {
    const on = !!document.fullscreenElement;
    b.innerHTML = on ? ICONS.leave : ICONS.enter;
    b.title = on ? 'Leave fullscreen (Esc)' : 'Fullscreen';
    b.setAttribute('aria-label', b.title);
  };
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.blur(); // (so the keys go to the page, not the button)
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', show);
  show();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addFullscreenButton);
else addFullscreenButton();
