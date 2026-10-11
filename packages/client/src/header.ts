import './header.css';

/**
 * The header bar of every page but the game: the name (home), the page's own name, the way to the
 * other pages, what the page puts there itself (the children of its #sv-header: a status and so
 * on), and the fullscreen button at the right (see fullscreen.ts). A page names itself with
 * data-title on its #sv-header.
 */
const PAGES: readonly { href: string; name: string; wide?: boolean; admin?: true }[] = [
  { href: '/', name: 'Home' },
  { href: '/worlds.html', name: 'World management', wide: true },
  { href: '/designer.html', name: 'Object designer', wide: true, admin: true },
  { href: '/animator.html', name: 'Animation designer', wide: true, admin: true },
  { href: '/meshes.html', name: 'Mesh editor', wide: true, admin: true },
  { href: '/players.html', name: 'Players', wide: true, admin: true },
  { href: '/account.html', name: 'My account' },
  { href: '/settings.html', name: 'Settings' },
];

function mountHeader(): void {
  let header = document.getElementById('sv-header');
  if (!header) {
    header = document.createElement('header');
    header.id = 'sv-header';
    document.body.prepend(header);
  }
  const extra = document.createElement('div');
  extra.className = 'sv-extra';
  extra.append(...header.childNodes);
  const brand = document.createElement('a');
  brand.className = 'sv-brand';
  brand.href = '/';
  brand.textContent = 'SuperVoxel';
  const parts: Node[] = [brand];
  const title = header.dataset.title;
  if (title) {
    const page = document.createElement('span');
    page.className = 'sv-page';
    page.textContent = title;
    parts.push(page);
  }
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Pages');
  const here = location.pathname === '/index.html' ? '/' : location.pathname;
  for (const p of PAGES) {
    const a = document.createElement('a');
    a.textContent = p.name;
    // (Settings come back here after.)
    a.href = p.href === '/settings.html' && here !== '/settings.html' ? `/settings.html?return=${encodeURIComponent(location.pathname + location.search + location.hash)}` : p.href;
    if (p.href === '/settings.html' && here !== '/settings.html') a.addEventListener('click', () => (a.href = `/settings.html?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`));
    if (p.wide) a.className = 'sv-wide';
    // (Admins' pages: hidden till the server says this is one, see showAdminLinks.)
    if (p.admin) {
      a.dataset.admin = '';
      a.hidden = true;
    }
    if (p.href === here) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  parts.push(nav, extra);
  const slot = document.createElement('span');
  slot.dataset.fullscreenSlot = '';
  parts.push(slot);
  header.replaceChildren(...parts);
  document.body.classList.add('sv-has-header');
  // (If the fullscreen button was put in the corner before there was a header, it moves up here.)
  const corner = document.querySelector('.fs-button.corner');
  if (corner) {
    corner.classList.remove('corner');
    slot.append(corner);
  }
}

/**
 * Shows the links to admins' pages (the header's, and any marked data-admin on the page itself:
 * the landing page's) if the server lets this one reach them (on development servers, anyone);
 * hides them if not (signed out, say).
 */
export async function showAdminLinks(): Promise<void> {
  const access = (await fetch('/api/access').then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { tools?: boolean } | null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-admin]')) el.hidden = !access?.tools;
}

mountHeader();
void showAdminLinks();
