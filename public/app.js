(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    login: $('login'), loginForm: $('loginForm'), loginError: $('loginError'), joinBtn: $('joinBtn'), joinLabel: $('joinLabel'),
    tabLogin: $('tabLogin'), tabSignup: $('tabSignup'), formTitle: $('formTitle'), formSub: $('formSub'),
    username: $('username'), password: $('password'), usernameHint: $('usernameHint'), passwordHint: $('passwordHint'),
    chat: $('chat'), frame: $('frame'), meName: $('meName'), meAvatar: $('meAvatar'), logout: $('logoutBtn'),
    search: $('search'), results: $('results'), listWrap: $('listWrap'),
    requestsBlock: $('requestsBlock'), requests: $('requests'), requestsCount: $('requestsCount'),
    chatList: $('chatList'), listEmpty: $('listEmpty'),
    noChat: $('noChat'), convo: $('convo'), back: $('backBtn'),
    peerName: $('peerName'), peerStatus: $('peerStatus'), peerAvatar: $('peerAvatar'),
    banner: $('banner'), requestBar: $('requestBar'), list: $('messages'), toBottom: $('toBottom'), unread: $('unreadCount'),
    composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'), toast: $('toast'),
  };

  const TITLE = 'Our Chat';
  const coarse = matchMedia('(pointer: coarse)').matches; // phones/tablets: Enter = new line

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ state */
  let token = store.get('chat.token');
  let me = null;
  let authMode = 'login';
  let source = null;                  // EventSource
  const chats = new Map();            // chatId -> summary from the server
  const cache = new Map();            // chatId -> messages[] (sorted by id)
  const loaded = new Set();           // chatIds whose history has been fetched
  const lastSeenSent = new Map();     // chatId -> highest peer message id we reported as seen
  const typingIn = new Map();         // chatId -> true while the peer is typing
  const typingTimers = new Map();
  let openId = null;                  // chat shown in the right panel
  let nodes = new Map();              // message id -> { row, tick } for the open chat
  let prev = null;                    // last rendered message (for grouping)
  let lastPing = 0;
  let recovering = false;
  let iAmTyping = false;
  let lastTypingSent = 0;
  let typingStopTimer = null;
  let toastTimer = null;
  let searchTimer = null;
  let searchSeq = 0;

  /* ---------------------------------------------------------------- helpers */
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d; };

  function dayLabel(ts) {
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return 'Today';
    if (k === dayKey(yesterday())) return 'Yesterday';
    const d = new Date(ts);
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function listTime(ts) {
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return fmtTime(ts);
    if (k === dayKey(yesterday())) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function lastSeenText(ts) {
    if (!ts) return 'offline';
    if (Date.now() - ts < 60000) return 'last seen just now';
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return `last seen today at ${fmtTime(ts)}`;
    if (k === dayKey(yesterday())) return `last seen yesterday at ${fmtTime(ts)}`;
    return `last seen ${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  }

  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
  function paintAvatar(node, name) {
    node.textContent = (Array.from(name.trim())[0] || '?').toUpperCase();
    const h = hue(name);
    node.style.background = `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 45%))`;
  }
  function avatar(name, cls) {
    const a = document.createElement('div');
    a.className = 'avatar' + (cls ? ' ' + cls : '');
    a.setAttribute('aria-hidden', 'true');
    paintAvatar(a, name);
    return a;
  }
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, onClick) {
    const b = h('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
    return b;
  }

  const TICK1 = '<svg viewBox="0 0 16 11" aria-label="Sent"><path d="M2 5.8 5.4 9.2 13.6 1.4"/></svg>';
  const TICK2 = '<svg viewBox="0 0 16 11" aria-label="Seen"><path d="M1 5.8 4.4 9.2 11.6 1.6"/><path d="M7.2 9.2 14.8 1.6"/></svg>';

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
  function linkify(node, text) {
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) node.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(text.slice(last));
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3500);
  }

  function setBanner(text) {
    el.banner.textContent = text;
    el.banner.classList.toggle('hidden', !text);
  }

  const visibleFocus = () => document.visibilityState === 'visible' && document.hasFocus();
  const atBottom = () => el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 80;
  function scrollBottom(smooth) { el.list.scrollTo({ top: el.list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }

  const totalUnread = () => { let n = 0; for (const c of chats.values()) if (c.status === 'active') n += c.unread; return n; };
  function updateUnreadUi() {
    const open = openId && chats.get(openId);
    el.toBottom.classList.toggle('hidden', atBottom());
    el.unread.textContent = open && open.unread ? String(open.unread) : '';
    const n = totalUnread() + incoming().length;
    document.title = n ? `(${n}) ${TITLE}` : TITLE;
  }

  /* -------------------------------------------------------------------- api */
  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    });
    let data = {};
    try { data = await r.json(); } catch { /* non-JSON error page */ }
    if (!r.ok) {
      if (r.status === 401 && path !== '/api/login' && path !== '/api/signup') signOut('Your session has ended. Please log in again.');
      const err = new Error(data.error || `Something went wrong (${r.status}).`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------- chat list */
  const incoming = () => [...chats.values()].filter((c) => c.status === 'pending' && c.requester !== me.id);
  const byRecent = (a, b) => b.updated - a.updated;

  function previewText(c) {
    if (c.status === 'pending') return 'Request sent';
    if (typingIn.get(c.id)) return 'typing…';
    if (!c.last) return 'Say hi 👋';
    return (c.last.from === me.id ? 'You: ' : '') + c.last.text.replace(/\s+/g, ' ');
  }

  function renderList() {
    if (!me) return;
    const reqs = incoming().sort(byRecent);
    el.requests.replaceChildren();
    for (const c of reqs) el.requests.append(requestItem(c));
    el.requestsBlock.classList.toggle('hidden', !reqs.length);
    el.requestsCount.textContent = reqs.length ? String(reqs.length) : '';

    const rest = [...chats.values()].filter((c) => c.status === 'active' || (c.status === 'pending' && c.requester === me.id)).sort(byRecent);
    el.chatList.replaceChildren();
    for (const c of rest) el.chatList.append(chatItem(c));
    el.listEmpty.classList.toggle('hidden', !!(rest.length || reqs.length));
    updateUnreadUi();
  }

  function chatItem(c) {
    const item = h('div', 'item' + (c.id === openId ? ' active' : ''));
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const av = avatar(c.peer.username);
    if (c.status === 'active' && c.peer.online) av.classList.add('on');
    const body = h('div', 'item-body');
    const top = h('div', 'item-top');
    top.append(h('span', 'item-name', c.peer.username));
    if (c.last) top.append(h('span', 'item-time', listTime(c.last.ts)));
    const bottom = h('div', 'item-bottom');
    bottom.append(h('span', 'item-preview' + (typingIn.get(c.id) ? ' typing' : ''), previewText(c)));
    if (c.unread) bottom.append(h('span', 'item-badge', c.unread > 99 ? '99+' : String(c.unread)));
    body.append(top, bottom);
    item.append(av, body);
    item.addEventListener('click', () => openChat(c.id));
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(c.id); } });
    return item;
  }

  function requestItem(c) {
    const item = h('div', 'item request' + (c.id === openId ? ' active' : ''));
    item.append(avatar(c.peer.username));
    const body = h('div', 'item-body');
    body.append(h('div', 'item-name', c.peer.username), h('div', 'item-preview', 'wants to connect'));
    const actions = h('div', 'item-actions');
    actions.append(
      button('Accept', 'mini primary-mini', (b) => respond(c.id, true, b)),
      button('Decline', 'mini', (b) => respond(c.id, false, b)),
    );
    body.append(actions);
    item.append(body);
    item.addEventListener('click', () => openChat(c.id));
    return item;
  }

  function upsertChat(c) {
    const old = chats.get(c.id);
    chats.set(c.id, c);
    if (!old && c.status === 'pending' && c.requester !== me.id) {
      toast(`${c.peer.username} wants to connect`);
      notify(`${c.peer.username} wants to connect`, 'Open Our Chat to accept or decline.');
    }
    if (old && old.status === 'pending' && c.status === 'active' && c.requester === me.id) toast(`${c.peer.username} accepted your request`);
    renderList();
    if (c.id === openId) refreshConvo(old && old.status);
  }

  function removeChat(id) {
    chats.delete(id); cache.delete(id); loaded.delete(id); lastSeenSent.delete(id); typingIn.delete(id);
    if (openId === id) closeConvo();
    renderList();
  }

  async function respond(chatId, accept, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/respond', { chatId, accept });
      upsertChat(r.chat);
      if (!accept && openId === chatId) closeConvo();
    } catch (err) { toast(err.message); if (btn) btn.disabled = false; }
  }

  async function cancelRequest(chatId, btn) {
    if (btn) btn.disabled = true;
    try { await api('/api/cancel', { chatId }); removeChat(chatId); }
    catch (err) { toast(err.message); if (btn) btn.disabled = false; }
  }

  /* ----------------------------------------------------------------- search */
  function clearSearch() {
    el.search.value = '';
    searchSeq++;
    el.results.classList.add('hidden');
    el.listWrap.classList.remove('hidden');
    el.results.replaceChildren();
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = el.search.value.trim().replace(/^@/, '');
    if (!q) { clearSearch(); return; }
    el.listWrap.classList.add('hidden');
    el.results.classList.remove('hidden');
    if (q.length < 2) { showResultsMessage('Keep typing… at least 2 characters.'); return; }
    searchTimer = setTimeout(() => runSearch(q), 250);
  }

  function showResultsMessage(text) {
    el.results.replaceChildren(h('div', 'results-msg', text));
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    try {
      const r = await api('/api/search', { q });
      if (seq !== searchSeq) return;
      renderResults(r.users);
    } catch (err) {
      if (seq === searchSeq) showResultsMessage(err.message);
    }
  }

  function renderResults(users) {
    el.results.replaceChildren();
    if (!users.length) { showResultsMessage('No one found with that username.'); return; }
    el.results.append(h('div', 'section-label', 'PEOPLE'));
    for (const u of users) {
      const row = h('div', 'item');
      row.append(avatar(u.username));
      const body = h('div', 'item-body');
      body.append(h('div', 'item-name', u.username));
      row.append(body);
      const act = h('div', 'result-action');
      if (u.relation === 'connected') {
        act.append(button('Message', 'mini primary-mini', () => { openChat(u.chatId); clearSearch(); }));
      } else if (u.relation === 'incoming') {
        act.append(button('Accept', 'mini primary-mini', async (b) => { await respond(u.chatId, true, b); openChat(u.chatId); clearSearch(); }));
      } else if (u.relation === 'requested') {
        act.append(h('span', 'tag', 'Requested'));
      } else {
        act.append(button('Connect', 'mini primary-mini', async (b) => {
          b.disabled = true;
          try {
            const r = await api('/api/connect', { username: u.username });
            upsertChat(r.chat);
            act.replaceChildren(r.chat.status === 'active' ? button('Message', 'mini primary-mini', () => { openChat(r.chat.id); clearSearch(); }) : h('span', 'tag', 'Requested'));
            toast(r.chat.status === 'active' ? `Connected with ${u.username}` : `Request sent to ${u.username}`);
          } catch (err) { toast(err.message); b.disabled = false; }
        }));
      }
      row.append(act);
      el.results.append(row);
    }
  }

  /* ------------------------------------------------------------ conversation */
  function openChat(id) {
    const c = chats.get(id);
    if (!c) return;
    if (openId && openId !== id) stopTyping();
    openId = id;
    nodes = new Map();
    prev = null;
    el.list.replaceChildren();
    el.noChat.classList.add('hidden');
    el.convo.classList.remove('hidden');
    el.frame.dataset.view = 'convo';
    if (!history.state || !history.state.chat) history.pushState({ chat: 1 }, '');
    renderHeader();
    refreshConvo();
    renderList();
    if (!coarse && c.status === 'active') el.input.focus();
  }

  function closeConvo() {
    stopTyping();
    openId = null;
    el.convo.classList.add('hidden');
    el.noChat.classList.remove('hidden');
    el.frame.dataset.view = 'list';
    renderList();
  }

  // (re)build everything that depends on the open chat's status
  function refreshConvo(prevStatus) {
    const c = chats.get(openId);
    if (!c) return;
    renderHeader();
    const active = c.status === 'active';
    el.composer.classList.toggle('hidden', !active);
    renderRequestBar(c);
    if (!active) {
      el.list.replaceChildren(h('div', 'empty', c.requester === me.id
        ? `Waiting for ${c.peer.username} to accept. You can chat once they do.`
        : `${c.peer.username} wants to connect with you. Accept to start chatting.`));
      return;
    }
    if (prevStatus && prevStatus !== 'active') { nodes = new Map(); prev = null; }
    if (loaded.has(openId)) { renderAll(); scrollBottom(false); markSeen(); }
    else loadMessages(openId);
  }

  function renderRequestBar(c) {
    el.requestBar.replaceChildren();
    if (c.status === 'active') { el.requestBar.classList.add('hidden'); return; }
    el.requestBar.classList.remove('hidden');
    if (c.requester === me.id) {
      el.requestBar.append(h('span', null, `Request sent to ${c.peer.username}`), button('Cancel request', 'mini', (b) => cancelRequest(c.id, b)));
    } else {
      el.requestBar.append(
        h('span', null, `${c.peer.username} wants to connect`),
        button('Accept', 'mini primary-mini', (b) => respond(c.id, true, b)),
        button('Decline', 'mini', (b) => respond(c.id, false, b)),
      );
    }
  }

  async function loadMessages(id) {
    el.list.replaceChildren(h('div', 'empty', 'Loading…'));
    try {
      const r = await api('/api/messages', { chatId: id });
      // merge with anything that arrived over the stream while we were loading
      const got = cache.get(id) || [];
      const map = new Map();
      for (const m of r.messages) map.set(m.id, m);
      for (const m of got) if (!map.has(m.id)) map.set(m.id, m);
      const msgs = [...map.values()].sort((a, b) => a.id - b.id);
      cache.set(id, msgs);
      loaded.add(id);
      lastSeenSent.set(id, msgs.reduce((hi, m) => (m.from !== me.id && m.seen ? Math.max(hi, m.id) : hi), 0));
      if (id !== openId) return;
      renderAll();
      scrollBottom(false);
      markSeen();
    } catch (err) {
      if (id === openId) el.list.replaceChildren(h('div', 'empty', err.message));
    }
  }

  /* ----------------------------------------------------------------- header */
  function renderHeader() {
    const c = chats.get(openId);
    if (!c) return;
    el.peerName.textContent = c.peer.username;
    paintAvatar(el.peerAvatar, c.peer.username);
    const s = el.peerStatus;
    s.replaceChildren();
    if (c.status !== 'active') { s.className = 'status'; s.textContent = c.requester === me.id ? 'request pending' : 'wants to connect'; return; }
    if (typingIn.get(c.id)) {
      s.className = 'status typing';
      s.append('typing');
      const dots = h('span', 'dots');
      dots.append(h('i'), h('i'), h('i'));
      s.append(dots);
    } else if (c.peer.online) {
      s.className = 'status online';
      s.textContent = 'online';
    } else {
      s.className = 'status';
      s.textContent = lastSeenText(c.peer.lastSeen);
    }
  }

  /* --------------------------------------------------------------- messages */
  function renderAll() {
    const msgs = cache.get(openId) || [];
    el.list.replaceChildren();
    nodes = new Map();
    prev = null;
    if (!msgs.length) { el.list.append(h('div', 'empty', 'No messages yet. Say hi 👋')); return; }
    for (const m of msgs) appendMsg(m, false);
  }

  function appendMsg(m, animate) {
    const empty = el.list.querySelector('.empty');
    if (empty) empty.remove();

    if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) {
      el.list.append(h('div', 'day', dayLabel(m.ts)));
      prev = null;
    }

    const mine = m.from === me.id;
    const cont = !!prev && prev.from === m.from && m.ts - prev.ts < 120000;
    if (cont) { const p = nodes.get(prev.id); if (p) p.row.classList.remove('tail'); }

    const row = h('div', `msg ${mine ? 'out' : 'in'} tail${cont ? ' cont' : ''}${animate ? ' pop' : ''}`);
    row.dataset.id = m.id;

    const bubble = h('div', 'bubble');
    const text = h('span', 'text');
    linkify(text, m.text);

    const meta = h('span', 'meta');
    const time = document.createElement('time');
    time.dateTime = new Date(m.ts).toISOString();
    time.textContent = fmtTime(m.ts);
    meta.append(time);

    let tick = null;
    if (mine) {
      tick = h('span', 'tick' + (m.seen ? ' seen' : ''));
      tick.innerHTML = m.seen ? TICK2 : TICK1; // static SVG strings only
      meta.append(tick);
    }

    bubble.append(text, meta);
    row.append(bubble);
    el.list.append(row);
    nodes.set(m.id, { row, tick });
    prev = m;
  }

  function onMessage(chatId, m) {
    const c = chats.get(chatId);
    if (!c) return;
    let arr = cache.get(chatId);
    if (!arr) cache.set(chatId, (arr = []));
    if (arr.some((x) => x.id === m.id)) return; // POST reply and stream echo both arrive

    const viewing = chatId === openId && loaded.has(chatId);
    const stick = viewing && atBottom();
    const last = arr[arr.length - 1];
    arr.push(m);
    c.last = { text: m.text.slice(0, 120), ts: m.ts, from: m.from };
    c.updated = m.ts;

    if (viewing) {
      if (last && m.id < last.id) { arr.sort((a, b) => a.id - b.id); renderAll(); }
      else appendMsg(m, true);
    }

    if (m.from === me.id) { if (viewing) scrollBottom(true); renderList(); return; }

    if (typingIn.get(chatId)) { typingIn.set(chatId, false); if (viewing) renderHeader(); }
    if (viewing && stick && visibleFocus()) { scrollBottom(true); renderList(); markSeen(); }
    else { c.unread++; renderList(); notify(c.peer.username, m.text); }
  }

  function applySeen(chatId, by, upTo, unread) {
    const c = chats.get(chatId);
    if (!c) return;
    if (by === me.id) {
      lastSeenSent.set(chatId, Math.max(lastSeenSent.get(chatId) || 0, upTo));
      c.unread = unread;
      renderList();
      return;
    }
    for (const m of cache.get(chatId) || []) {
      if (m.from === by || m.id > upTo || m.seen) continue;
      m.seen = true;
      const n = chatId === openId ? nodes.get(m.id) : null;
      if (n && n.tick) { n.tick.classList.add('seen'); n.tick.innerHTML = TICK2; }
    }
  }

  function markSeen() {
    const c = chats.get(openId);
    if (!c || c.status !== 'active' || !loaded.has(openId) || !visibleFocus() || !atBottom()) return;
    if (c.unread) { c.unread = 0; renderList(); }
    updateUnreadUi();
    const msgs = cache.get(openId) || [];
    let top = 0;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].from !== me.id) { top = msgs[i].id; break; }
    const sent = lastSeenSent.get(openId) || 0;
    if (top > sent) {
      const id = openId;
      lastSeenSent.set(id, top);
      api('/api/seen', { chatId: id, upTo: top }).catch(() => { if (lastSeenSent.get(id) === top) lastSeenSent.set(id, sent); });
    }
  }

  function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || visibleFocus()) return;
    try {
      const n = new Notification(title, { body: String(body).slice(0, 140), tag: 'chat' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }

  /* ------------------------------------------------------------------ typing */
  function onTyping() {
    if (!el.input.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (!iAmTyping || now - lastTypingSent > 2500) {
      iAmTyping = true;
      lastTypingSent = now;
      api('/api/typing', { chatId: openId, typing: true }).catch(() => {});
    }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 3000);
  }
  let typingChat = null;
  function stopTyping() {
    clearTimeout(typingStopTimer);
    if (iAmTyping) { iAmTyping = false; api('/api/typing', { chatId: typingChat || openId, typing: false }).catch(() => {}); }
  }

  /* -------------------------------------------------------------- connection */
  function disconnect() {
    if (source) { source.close(); source = null; }
  }

  function connect() {
    disconnect();
    setBanner('Connecting…');
    const es = new EventSource('/api/stream?token=' + encodeURIComponent(token));
    source = es;
    lastPing = Date.now();
    const on = (name, fn) => es.addEventListener(name, (e) => { lastPing = Date.now(); fn(JSON.parse(e.data)); });

    on('init', onInit);
    on('chat', upsertChat);
    on('chatRemoved', (d) => removeChat(d.chatId));
    on('msg', (d) => onMessage(d.chatId, d.message));
    on('seen', (d) => applySeen(d.chatId, d.by, d.upTo, d.unread));
    on('typing', (d) => {
      typingIn.set(d.chatId, !!d.typing);
      clearTimeout(typingTimers.get(d.chatId));
      if (d.typing) typingTimers.set(d.chatId, setTimeout(() => { typingIn.set(d.chatId, false); if (d.chatId === openId) renderHeader(); renderList(); }, 5000));
      if (d.chatId === openId) renderHeader();
      renderList();
    });
    on('presence', (d) => {
      for (const c of chats.values()) {
        if (c.peer.id !== d.userId) continue;
        c.peer.online = d.online;
        c.peer.lastSeen = d.lastSeen;
        if (!d.online) typingIn.set(c.id, false);
      }
      if (openId) renderHeader();
      renderList();
    });
    on('ping', () => {});
    es.onopen = () => setBanner('');
    es.onerror = () => {
      if (es !== source) return;
      setBanner('Reconnecting…');
      // The browser retries by itself, unless the response was a hard failure (CLOSED).
      if (es.readyState === EventSource.CLOSED) recover();
    };
  }

  async function recover() {
    if (recovering || !token) return;
    recovering = true;
    try {
      await api('/api/ping'); // 401 here signs us out; any other error means "server not back yet"
      recovering = false;
      connect();
    } catch (e) {
      recovering = false;
      if (e.status !== 401 && token) setTimeout(recover, 3000);
    }
  }

  function onInit(d) {
    me = d.me;
    chats.clear();
    for (const c of d.chats) chats.set(c.id, c);
    // history may have changed while we were away: refetch lazily
    cache.clear(); loaded.clear(); typingIn.clear();
    el.meName.textContent = me.username;
    paintAvatar(el.meAvatar, me.username);
    showApp();
    setBanner('');
    renderList();
    if (openId && chats.has(openId)) { nodes = new Map(); prev = null; refreshConvo(); }
    else if (openId) closeConvo();
  }

  /* ----------------------------------------------------------------- screens */
  function showApp() {
    el.login.classList.add('hidden');
    el.chat.classList.remove('hidden');
  }

  function setMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    el.tabLogin.classList.toggle('active', !signup);
    el.tabSignup.classList.toggle('active', signup);
    el.tabLogin.setAttribute('aria-selected', String(!signup));
    el.tabSignup.setAttribute('aria-selected', String(signup));
    el.formTitle.textContent = signup ? 'Create your account.' : 'Welcome back.';
    el.formSub.textContent = signup ? 'Choose a username people can find you by.' : 'Log in to see your conversations.';
    el.joinLabel.textContent = signup ? 'Create account' : 'Log in';
    el.usernameHint.classList.toggle('hidden', !signup);
    el.passwordHint.classList.toggle('hidden', !signup);
    el.password.autocomplete = signup ? 'new-password' : 'current-password';
    el.password.minLength = signup ? 8 : 0;
    el.password.placeholder = signup ? 'At least 8 characters' : 'Your password';
    el.loginError.textContent = '';
  }

  function showLogin(message) {
    el.chat.classList.add('hidden');
    el.login.classList.remove('hidden');
    setMode('login');
    el.loginError.textContent = message || '';
    el.username.value = store.get('chat.username') || '';
    el.password.value = '';
    (el.username.value ? el.password : el.username).focus();
  }

  function signOut(message) {
    disconnect();
    token = null;
    store.del('chat.token');
    me = null; openId = null; nodes = new Map(); prev = null;
    chats.clear(); cache.clear(); loaded.clear(); lastSeenSent.clear(); typingIn.clear();
    clearSearch();
    el.list.replaceChildren();
    el.convo.classList.add('hidden');
    el.noChat.classList.remove('hidden');
    el.frame.dataset.view = 'list';
    document.title = TITLE;
    showLogin(message);
  }

  /* ------------------------------------------------------------------ events */
  el.tabLogin.addEventListener('click', () => setMode('login'));
  el.tabSignup.addEventListener('click', () => setMode('signup'));

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.loginError.textContent = '';
    el.joinBtn.disabled = true;
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission().catch(() => {}); } catch { /* old Safari */ }
    }
    try {
      token = null;
      const r = await api(authMode === 'signup' ? '/api/signup' : '/api/login', { username: el.username.value, password: el.password.value });
      token = r.token;
      store.set('chat.token', token);
      store.set('chat.username', r.username);
      el.password.value = '';
      connect();
    } catch (err) {
      el.loginError.textContent = err.message;
    } finally {
      el.joinBtn.disabled = false;
    }
  });

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }

  async function send() {
    const text = el.input.value.trim();
    const chatId = openId;
    if (!text || !me || !chatId) return;
    el.input.value = '';
    autosize();
    el.sendBtn.disabled = true;
    stopTyping();
    el.input.focus();
    try {
      const r = await api('/api/send', { chatId, text });
      onMessage(chatId, r.message);
    } catch (err) {
      if (!el.input.value && chatId === openId) { el.input.value = text; autosize(); el.sendBtn.disabled = false; }
      toast(err.message);
    }
  }

  el.input.addEventListener('input', () => {
    autosize();
    el.sendBtn.disabled = !el.input.value.trim();
    typingChat = openId;
    onTyping();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); send(); }
  });
  el.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  el.sendBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard open

  el.search.addEventListener('input', onSearchInput);
  el.search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearSearch(); el.search.blur(); } });

  el.list.addEventListener('scroll', () => { updateUnreadUi(); if (atBottom()) markSeen(); }, { passive: true });
  el.toBottom.addEventListener('click', () => { scrollBottom(true); setTimeout(markSeen, 350); });

  el.back.addEventListener('click', () => {
    if (history.state && history.state.chat) history.back(); else closeConvo();
  });
  addEventListener('popstate', () => { if (openId) closeConvo(); });

  el.logout.addEventListener('click', () => {
    if (!confirm('Log out on this device? Your messages stay saved.')) return;
    const p = api('/api/logout');
    signOut('');
    p.catch(() => {});
  });

  addEventListener('focus', markSeen);
  addEventListener('online', () => { if (token) connect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !token) return;
    if (Date.now() - lastPing > 40000) connect(); // phone was asleep; the stream is probably dead
    markSeen();
  });

  // Watchdog (server pings every 25s) and keeping "last seen" fresh
  setInterval(() => {
    if (token && source && Date.now() - lastPing > 60000) connect();
    if (openId) renderHeader();
  }, 15000);

  /* -------------------------------------------------------------------- boot */
  if (token) { el.login.classList.add('hidden'); setBanner('Connecting…'); connect(); }
  else showLogin('');
})();
