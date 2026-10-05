/**
 * Marks pages served by a server that isn't the live game or a development one (staging: see
 * APP_ENV), so the two aren't confused: a badge at the top, and the environment in the tab's title.
 */
void fetch('/api/health')
  .then((r) => r.json() as Promise<{ environment?: string }>)
  .then(({ environment }) => {
    if (!environment || environment === 'production' || environment === 'development') return;
    const badge = document.createElement('div');
    badge.textContent = environment.toUpperCase();
    badge.title = `the ${environment} server: not the live game`;
    // (In the header, on pages that have it: see header.ts.)
    const header = document.querySelector('#sv-header .sv-extra');
    if (header) {
      badge.className = 'sv-env';
      header.prepend(badge);
      document.title = `[${environment}] ${document.title}`;
      return;
    }
    badge.style.cssText =
      'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:1000;padding:2px 12px;border-radius:0 0 6px 6px;' +
      'background:#e3b341;color:#000;font:600 11px/1.6 system-ui,sans-serif;letter-spacing:.1em;pointer-events:none';
    document.body.append(badge);
    document.title = `[${environment}] ${document.title}`;
  })
  .catch(() => {});
