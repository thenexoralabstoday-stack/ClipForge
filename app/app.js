/* Copyright (c) 2026 Nexora Labs. All rights reserved. */
/* ClipForge — shared app runtime: API client, session, shell, toasts, modals.
   Every app page loads this and calls CF.mount({...}) once. */
(function () {
  'use strict';

  const API = (window.CLIPFORGE_API || document.querySelector('meta[name="clipforge-api-base"]')?.content || '/api').replace(/\/$/, '');

  const session = {
    get token() { return localStorage.getItem('clipforge_token'); },
    get user() { try { return JSON.parse(localStorage.getItem('clipforge_user') || 'null'); } catch { return null; } },
    set(token, user) { localStorage.setItem('clipforge_token', token); localStorage.setItem('clipforge_user', JSON.stringify(user)); },
    clear() { localStorage.removeItem('clipforge_token'); localStorage.removeItem('clipforge_user'); },
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function logout() {
    session.clear();
    location.href = '/';
  }

  /** JSON fetch against the API. A 401 ends the session and sends the user to sign in. */
  async function api(path, opts = {}) {
    const headers = { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(session.token ? { Authorization: 'Bearer ' + session.token } : {}), ...(opts.headers || {}) };
    const res = await fetch(API + path, { ...opts, headers });
    if (res.status === 401) { session.clear(); location.href = '/?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  /* ── toasts ── */
  function toast(message, type = 'info', ms = 3400) {
    let host = document.querySelector('.toasts');
    if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.append(host); }
    const el = document.createElement('div');
    el.className = 'toast toast--' + type; el.textContent = message; el.setAttribute('role', 'status');
    host.append(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
  }

  /* ── modal ── */
  function modal({ title, body, actions = [], onClose } = {}) {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const box = document.createElement('div'); box.className = 'modal'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const head = document.createElement('div'); head.className = 'modal__head';
    head.innerHTML = `<h2>${esc(title)}</h2><button class="btn btn--ghost btn--sm" aria-label="Close">✕</button>`;
    const bodyEl = document.createElement('div'); bodyEl.className = 'modal__body';
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    const foot = document.createElement('div'); foot.className = 'modal__foot';
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.kind === 'primary' ? 'btn--primary' : a.kind === 'danger' ? 'btn--danger' : '');
      b.textContent = a.label;
      b.onclick = async () => {
        if (!a.onClick) return close();
        b.classList.add('is-busy');
        try { const keep = await a.onClick({ close, box: bodyEl, button: b }); if (keep !== true) close(); }
        catch (e) { toast(e.message, 'error'); }
        finally { b.classList.remove('is-busy'); }
      };
      foot.append(b);
    }
    head.querySelector('button').onclick = close;
    bg.onclick = e => { if (e.target === bg) close(); };
    document.addEventListener('keydown', onKey);
    box.append(head, bodyEl); if (actions.length) box.append(foot); bg.append(box); document.body.append(bg);
    setTimeout(() => (bodyEl.querySelector('input,select,textarea,button') || head.querySelector('button')).focus(), 30);
    return { close, body: bodyEl };
  }

  function confirm(message, { label = 'Confirm', kind = 'danger', title = 'Are you sure?' } = {}) {
    return new Promise(resolve => {
      modal({ title, body: `<p>${esc(message)}</p>`, actions: [
        { label: 'Cancel', onClick: () => { resolve(false); } },
        { label, kind, onClick: () => { resolve(true); } },
      ], onClose: () => resolve(false) });
    });
  }

  /* ── helpers ── */
  const fmt = {
    date: t => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—',
    ago(t) {
      if (!t) return '—';
      const s = Math.max(0, (Date.now() - new Date(t)) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + ' min ago';
      if (s < 86400) return Math.floor(s / 3600) + ' h ago';
      return fmt.date(t);
    },
    secs: n => (n == null ? '—' : Number(n).toFixed(1) + 's'),
    initials: name => (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(),
    // 'clips_ready' reads as 'Clips ready', not CLIPS_READY.
    title: s => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()),
  };

  const STATUS_KIND = { done: 'ok', rendered: 'ok', published: 'ok', analyzed: 'ok', clips_ready: 'ok', uploaded: 'info', created: 'muted', pending: 'muted', skipped: 'muted', rendering: 'warn', processing: 'warn', analyzing: 'warn', running: 'warn', queued: 'warn', failed: 'bad', error: 'bad' };
  const BUSY = ['rendering', 'processing', 'analyzing', 'running', 'queued'];
  const badge = (status, extra = '') => `<span class="badge badge--${STATUS_KIND[status] || 'muted'} ${BUSY.includes(status) ? 'badge--pulse' : ''} ${extra}">${esc(fmt.title(status || 'pending'))}</span>`;

  function busy(btn, on) { btn && btn.classList.toggle('is-busy', !!on); if (btn) btn.disabled = !!on; }

  /* ── shell ── */
  const ICON = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    projects: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    publish: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    sounds: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
    billing: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  const NAV = [
    { id: 'home', label: 'Home', href: '/home.html' },
    { id: 'projects', label: 'Projects', href: '/projects.html' },
    { id: 'publish', label: 'Publish', href: '/publish.html' },
    { id: 'sounds', label: 'Sounds', href: '/meme-sounds.html', secondary: true },
    { id: 'billing', label: 'Billing', href: '/billing.html' },
    { id: 'settings', label: 'Settings', href: '/settings.html' },
  ];
  const FLAME = '<svg viewBox="0 0 24 24"><path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 1-3 0 2 1 3 2 3 1-3-1-5 2-11z"/></svg>';

  /**
   * Wraps the page's <main id="page"> in the sidebar + topbar shell.
   * Requires a session; otherwise redirects to sign-in and returns null.
   */
  function mount({ active, title, crumbs = [], actions = [], requireAuth = true } = {}) {
    const user = session.user;
    if (requireAuth && (!session.token || !user)) {
      location.replace('/?next=' + encodeURIComponent(location.pathname + location.search));
      return null;
    }
    const page = document.getElementById('page');
    const app = document.createElement('div'); app.className = 'app';
    const sb = document.createElement('aside'); sb.className = 'sb';
    const primary = NAV.filter(n => !n.secondary), secondary = NAV.filter(n => n.secondary);
    const link = n => `<a class="sb__link ${n.id === active ? 'is-active' : ''}" href="${n.href}" ${n.id === active ? 'aria-current="page"' : ''}>${ICON[n.id]}<span>${n.label}</span></a>`;
    sb.innerHTML = `
      <a class="sb__brand" href="/home.html"><span class="sb__mark">${FLAME}</span><span class="sb__name">ClipForge</span></a>
      <div class="sb__group"><div class="sb__label meta">Workspace</div><nav class="sb__nav">${primary.map(link).join('')}</nav></div>
      <div class="sb__group sb__group--secondary"><div class="sb__label meta">Tools</div><nav class="sb__nav">${secondary.map(link).join('')}</nav></div>
      <div class="sb__spacer"></div>
      <a class="sb__user" href="/settings.html"><span class="avatar">${esc(fmt.initials(user?.name))}</span><span style="min-width:0"><div class="sb__user-name">${esc(user?.name || 'Account')}</div><div class="sb__user-plan">${esc(fmt.title(user?.plan || 'free'))} plan</div></span></a>
      <button class="sb__signout" type="button">Sign out</button>`;
    sb.querySelector('.sb__signout').onclick = logout;

    const main = document.createElement('div'); main.className = 'main';
    const topbar = document.createElement('header'); topbar.className = 'topbar';
    const crumbHtml = crumbs.map(c => c.href ? `<a href="${c.href}">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`).join('');
    topbar.innerHTML = `<div class="row" style="gap:14px;min-width:0"><a class="topbar__brand" href="/home.html"><span class="sb__mark">${FLAME}</span>ClipForge</a><div class="topbar__crumbs">${crumbHtml}${crumbs.length ? '<span class="topbar__title">' : '<span class="topbar__title" style="margin:0">'}${esc(title || '')}</span></div></div><div class="topbar__actions"></div>`;
    if (!crumbs.length) topbar.querySelector('.topbar__title').style.cssText = 'margin:0';
    const actionsEl = topbar.querySelector('.topbar__actions');
    for (const a of actions) {
      const b = document.createElement(a.href ? 'a' : 'button');
      if (a.href) b.href = a.href;
      b.className = 'btn ' + (a.kind === 'primary' ? 'btn--primary' : a.kind === 'ghost' ? 'btn--ghost' : '');
      b.innerHTML = (a.icon ? ICON[a.icon] || a.icon : '') + esc(a.label);
      if (a.id) b.id = a.id;
      if (a.onClick) b.onclick = () => a.onClick(b);
      actionsEl.append(b);
    }
    page.classList.add('content');
    page.parentNode.insertBefore(app, page);
    main.append(topbar, page);
    app.append(sb, main);
    return { user, topbar, actions: actionsEl };
  }

  /* ── settings cache (user defaults) ── */
  const settings = {
    async get() { const d = await api('/me/settings'); return d.settings; },
    async save(patch) { const d = await api('/me/settings', { method: 'PATCH', body: JSON.stringify(patch) }); return d.settings; },
  };

  /** Read ?connected= / ?error= style flags once and clear them from the URL. */
  function takeQuery(...keys) {
    const p = new URLSearchParams(location.search); const out = {};
    let touched = false;
    for (const k of keys) if (p.has(k)) { out[k] = p.get(k); p.delete(k); touched = true; }
    if (touched) history.replaceState({}, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
    return out;
  }

  window.CF = { API, session, api, esc, toast, modal, confirm, fmt, badge, busy, mount, settings, logout, takeQuery, ICON };
})();
