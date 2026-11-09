/* global Hls */

// ---- Kleine hulpfuncties

/** Bouwt elementen met textContent, zodat namen uit afspeellijsten nooit als HTML worden uitgevoerd. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const ICONS = {
  tv: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="m8 2 4 4 4-4"/>',
  guide: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18M9 4v17"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"/>',
  series: '<rect x="2" y="7" width="15" height="13" rx="2"/><path d="M6 3h14a2 2 0 0 1 2 2v10"/>',
  star: '<path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4-6 8-6s7 1.5 8 6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-5v5h5M4 13a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  replay: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  forward: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  next: '<path d="M5 5v14l10-7z"/><path d="M19 5v14"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

function icon(name, filled = false) {
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  wrap.innerHTML = `<svg class="icon${filled ? ' filled' : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return wrap.firstChild;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('De server is niet bereikbaar.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.mustChangePassword && state.user && !state.user.mustChangePassword) {
    state.user.mustChangePassword = true;
    stopPlayback();
    renderApp();
  }
  if (res.status === 401 && state.user && path !== '/api/login') {
    state.user = null;
    stopPlayback();
    renderApp();
  }
  if (!res.ok) throw new Error(data.error || 'Er ging iets mis.');
  return data;
}

function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

const time = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const dateTime = (ms) => new Date(ms).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function clock(seconds) {
  const s = Math.floor(seconds);
  const parts = [Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0'));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${parts.join(':')}` : `${Math.floor(s / 60)}:${parts[1]}`;
}

// Haalt de landcode weg uit namen: "┃NL┃ NPO 1 HD" wordt "NPO 1 HD". Het land staat al in de landkeuze.
const COUNTRY_TAG = /^\s*[┃|[(]\s*[A-Z]{2,5}(?: [A-Z]{2})?\s*[┃|\]):]\s*/u;
function clean(text) {
  const original = String(text ?? '');
  return original.replace(COUNTRY_TAG, '') || original;
}

const logoBox = (item) => h('div', { class: 'logo-box' },
  item.logo
    ? h('img', { src: item.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() })
    : clean(item.name).slice(0, 2).toUpperCase());

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---- Toestand

const state = { user: null, needsSetup: false, view: null };
const COUNTRY_KEY = 'kijkbox-land';
const liveFilter = { country: localStorage.getItem(COUNTRY_KEY) ?? 'NL', group: '', q: '', fav: false };
const browseState = { movie: { group: '', q: '' }, series: { group: '', q: '' } };
// Geen crypto.randomUUID: die bestaat alleen op https en localhost, niet op een http-adres thuis.
const cid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// De tv-app voegt "KijkboxTV" toe aan de naam van de browser. Met ?tv kun je de tv-weergave ook elders bekijken.
const TV = /KijkboxTV/.test(navigator.userAgent) || new URLSearchParams(location.search).has('tv');
if (TV) {
  document.body.classList.add('tv');
  const version = document.querySelector('meta[name=kijkbox-version]')?.content ?? '';
  document.head.append(h('link', { rel: 'stylesheet', href: `/tv.css?v=${version}` }));
}

// ---- Kleurthema per account (leeg = standaardgeel). Moet gelijk lopen met THEMES op de server.

const THEMES = [
  ['', 'Geel', '#f2b632'],
  ['oranje', 'Oranje', '#ff8a3d'],
  ['rood', 'Rood', '#ff5f5f'],
  ['roze', 'Roze', '#f472b6'],
  ['paars', 'Paars', '#a78bfa'],
  ['blauw', 'Blauw', '#4c9dff'],
  ['turquoise', 'Turquoise', '#2dd4bf'],
  ['groen', 'Groen', '#4ade80'],
];
const THEME_KEY = 'kijkbox-thema';

const isCustomColor = (value) => /^#[0-9a-f]{6}$/i.test(value ?? '');

/** De kleur bij een thema: een van de vaste kleuren, of een eigen kleur (#rrggbb). */
function themeColor(name) {
  if (isCustomColor(name)) return name;
  return (THEMES.find(([key]) => key === (name ?? '')) ?? THEMES[0])[2];
}

/** Donkere of witte tekst op een gekleurde knop, afhankelijk van hoe licht de kleur is. */
function inkFor(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#16130a' : '#ffffff';
}

function applyTheme(name) {
  const color = themeColor(name);
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-ink', inkFor(color));
  try { localStorage.setItem(THEME_KEY, isCustomColor(name) ? name : (THEMES.find(([key]) => key === name) ?? THEMES[0])[0]); } catch {}
}
// Meteen de laatst gebruikte kleur, zodat er bij het openen geen geel flitst.
try { applyTheme(localStorage.getItem(THEME_KEY) ?? ''); } catch {}

// ---- Eigen stijl per account: hoeken, knoppen, letters, postergrootte en achtergrond.
// Moet gelijk lopen met LOOK_OPTIONS op de server.
const LOOK_CHOICES = [
  ['corners', 'Hoeken', [['', 'Normaal'], ['round', 'Rond'], ['square', 'Strak']]],
  ['buttons', 'Knoppen', [['', 'Gevuld'], ['pill', 'Pil'], ['outline', 'Omlijnd']]],
  ['font', 'Letters', [['', 'Standaard'], ['rounded', 'Zacht'], ['serif', 'Klassiek'], ['mono', 'Typemachine']]],
  ['cards', 'Posters', [['', 'Normaal'], ['small', 'Klein'], ['large', 'Groot']]],
  ['background', 'Achtergrond', [['', 'Glas'], ['gradient', 'Kleurverloop'], ['plain', 'Effen']]],
  // Patronen worden met voorbeeldtegels gekozen (zie patternPicker), niet met knoppen.
  ['pattern', 'Patroon', [['', 'Geen'], ['dots', 'Stippen'], ['grid', 'Raster'], ['lines', 'Strepen'], ['waves', 'Golven'],
    ['stars', 'Sterren'], ['bubbles', 'Bubbels'], ['topo', 'Hoogtelijnen'], ['aurora', 'Noorderlicht']]],
];
const LOOK_PRESETS = [
  ['Standaard', {}],
  ['Bioscoop', { corners: 'square', font: 'serif', cards: 'large', background: 'gradient', pattern: 'stars' }],
  ['Speels', { corners: 'round', buttons: 'pill', font: 'rounded', background: 'gradient', pattern: 'bubbles' }],
  ['Retro', { corners: 'square', buttons: 'outline', font: 'mono', background: 'plain', pattern: 'grid' }],
  ['Glas', { corners: 'round', buttons: 'pill', pattern: 'aurora' }],
];
const LOOK_KEY = 'kijkbox-stijl';

function applyLook(look) {
  const root = document.documentElement;
  for (const [key] of LOOK_CHOICES) {
    if (look?.[key]) root.dataset[key] = look[key];
    else delete root.dataset[key];
  }
  // Glas is de standaard; alleen "Effen" zet het uit.
  const background = look?.background === 'glass' ? '' : look?.background ?? '';
  if (background === 'plain') delete root.dataset.background;
  else root.dataset.background = background || 'glass';
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look ?? {})); } catch {}
}
try { applyLook(JSON.parse(localStorage.getItem(LOOK_KEY) || '{}')); } catch {}

// ---- Weergave per account: donker (standaard), licht of OLED-zwart
const APPEARANCES = [['', 'Donker'], ['light', 'Licht'], ['oled', 'OLED-zwart']];
const APPEARANCE_KEY = 'kijkbox-weergave';

function applyAppearance(value) {
  const name = APPEARANCES.some(([key]) => key === value) ? value : '';
  if (name) document.documentElement.dataset.appearance = name;
  else delete document.documentElement.dataset.appearance;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', name === 'light' ? '#f4f5f7' : name === 'oled' ? '#000000' : '#101216');
  try { localStorage.setItem(APPEARANCE_KEY, name); } catch {}
}
try { applyAppearance(localStorage.getItem(APPEARANCE_KEY) ?? ''); } catch {}

// ---- Tekstgrootte op de tv (per apparaat: elke tv staat op een andere afstand)
const TV_SIZES = [['1', 'Normaal'], ['1.15', 'Groot'], ['1.3', 'Extra groot']];
const TV_SIZE_KEY = 'kijkbox-tv-tekst';

function applyTvSize(value) {
  const size = TV_SIZES.some(([key]) => key === value) ? value : '1';
  document.documentElement.style.setProperty('--tv-zoom', size);
  try { localStorage.setItem(TV_SIZE_KEY, size); } catch {}
}
try { applyTvSize(localStorage.getItem(TV_SIZE_KEY) ?? '1'); } catch {}

/** Rij met keuzeknoppen (werkt ook met de afstandsbediening). */
function choiceRow(label, options, current, onPick) {
  const buttons = options.map(([value, text]) => h('button', {
    type: 'button',
    class: `chip${value === current ? ' active' : ''}`,
    'aria-pressed': String(value === current),
    onclick: () => {
      for (const b of buttons) {
        const on = b === buttons[options.findIndex(([v]) => v === value)];
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      onPick(value);
    },
  }, text));
  return h('div', { class: 'theme-picker' }, h('div', { class: 'muted small' }, label), h('div', { class: 'chips' }, buttons));
}

// ---- Inloggen

function authScreen({ title, intro, fields, submit, action }) {
  const error = h('p', { class: 'error small', hidden: true });
  const button = h('button', { class: 'btn primary', type: 'submit' }, submit);
  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.hidden = true;
      try {
        await action(Object.fromEntries(new FormData(form)));
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    },
  }, fields, error, button);
  return h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Kijkbox'),
    h('div', {}, h('h1', {}, title), intro && h('p', { class: 'muted' }, intro)),
    form));
}

const field = (label, props) => h('label', {}, label, h('input', props));

// ---- Tv: wie kijkt er? Profielen van de accounts die op deze tv zijn aangemeld
const PROFILE_CHOSEN = 'kijkbox-profiel-gekozen';
const profileChosen = () => { try { return sessionStorage.getItem(PROFILE_CHOSEN) === '1'; } catch { return false; } };
const markProfileChosen = () => { try { sessionStorage.setItem(PROFILE_CHOSEN, '1'); } catch {} };

/** Vanuit Account: terug naar de profielkeuze. */
function showProfiles() {
  stopPlayback();
  try { sessionStorage.removeItem(PROFILE_CHOSEN); } catch {}
  state.profiles = Math.max(state.profiles ?? 0, 1);
  renderApp();
}

// Profielfoto's: eenvoudige figuurtjes op de kleur van het account (100 x 100).
const W = '#fff';
const D = '#23262d';
const AVATAR_ART = {
  a1: ['Kat', `<path d="M26 46 30 16l18 18zM74 46 70 16 52 34z" fill="${W}"/><circle cx="50" cy="58" r="28" fill="${W}"/>
    <circle cx="40" cy="55" r="3.6" fill="${D}"/><circle cx="60" cy="55" r="3.6" fill="${D}"/><path d="m46 63 4 4 4-4z" fill="#f08aa5"/>
    <path d="M20 62h14M21 69l13-3M80 62H66M79 69l-13-3" stroke="${D}" stroke-width="2" stroke-linecap="round"/>`],
  a2: ['Vos', `<path d="M22 40 26 12l18 20zM78 40 74 12 56 32z" fill="${W}"/><path d="M20 40Q50 26 80 40L50 84z" fill="${W}"/>
    <path d="M20 40 50 84 36 54z" fill="rgba(0,0,0,.08)"/><circle cx="40" cy="50" r="3.6" fill="${D}"/><circle cx="60" cy="50" r="3.6" fill="${D}"/>
    <circle cx="50" cy="78" r="4.5" fill="${D}"/>`],
  a3: ['Robot', `<path d="M50 32V20" stroke="${D}" stroke-width="3"/><circle cx="50" cy="18" r="5" fill="${D}"/>
    <rect x="22" y="46" width="7" height="14" rx="3" fill="${W}"/><rect x="71" y="46" width="7" height="14" rx="3" fill="${W}"/>
    <rect x="27" y="32" width="46" height="44" rx="10" fill="${W}"/><circle cx="40" cy="50" r="6" fill="${D}"/><circle cx="60" cy="50" r="6" fill="${D}"/>
    <circle cx="42" cy="48" r="1.8" fill="${W}"/><circle cx="62" cy="48" r="1.8" fill="${W}"/><rect x="39" y="63" width="22" height="5" rx="2.5" fill="${D}"/>`],
  a4: ['Alien', `<path d="M38 28 30 14M62 28l8-14" stroke="${W}" stroke-width="3" stroke-linecap="round"/><circle cx="30" cy="13" r="4" fill="${W}"/>
    <circle cx="70" cy="13" r="4" fill="${W}"/><ellipse cx="50" cy="55" rx="26" ry="30" fill="${W}"/>
    <ellipse cx="39" cy="54" rx="7" ry="11" transform="rotate(-25 39 54)" fill="${D}"/><ellipse cx="61" cy="54" rx="7" ry="11" transform="rotate(25 61 54)" fill="${D}"/>
    <path d="M44 72q6 4 12 0" stroke="${D}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`],
  a5: ['Spookje', `<path d="M27 82V48a23 23 0 0 1 46 0v34l-7.7-6-7.6 6-7.7-6-7.7 6-7.6-6z" fill="${W}"/>
    <ellipse cx="42" cy="50" rx="4" ry="5.5" fill="${D}"/><ellipse cx="58" cy="50" rx="4" ry="5.5" fill="${D}"/><ellipse cx="50" cy="62" rx="3.5" ry="4.5" fill="${D}"/>`],
  a6: ['Beer', `<circle cx="30" cy="34" r="11" fill="${W}"/><circle cx="70" cy="34" r="11" fill="${W}"/><circle cx="30" cy="34" r="5" fill="rgba(0,0,0,.1)"/>
    <circle cx="70" cy="34" r="5" fill="rgba(0,0,0,.1)"/><circle cx="50" cy="57" r="27" fill="${W}"/><ellipse cx="50" cy="66" rx="12" ry="9" fill="rgba(0,0,0,.1)"/>
    <ellipse cx="50" cy="62" rx="4.5" ry="3.3" fill="${D}"/><circle cx="40" cy="51" r="3.4" fill="${D}"/><circle cx="60" cy="51" r="3.4" fill="${D}"/>`],
  a7: ['Uil', `<path d="M26 36 28 20l12 10zM74 36l-2-16-12 10z" fill="${W}"/><ellipse cx="50" cy="57" rx="27" ry="28" fill="${W}"/>
    <circle cx="39" cy="50" r="10" fill="none" stroke="${D}" stroke-width="3"/><circle cx="61" cy="50" r="10" fill="none" stroke="${D}" stroke-width="3"/>
    <circle cx="39" cy="50" r="4" fill="${D}"/><circle cx="61" cy="50" r="4" fill="${D}"/><path d="m45 62h10l-5 8z" fill="#f5a524"/>`],
  a8: ['Kikker', `<circle cx="33" cy="40" r="11" fill="${W}"/><circle cx="67" cy="40" r="11" fill="${W}"/><ellipse cx="50" cy="62" rx="31" ry="21" fill="${W}"/>
    <circle cx="33" cy="40" r="4.5" fill="${D}"/><circle cx="67" cy="40" r="4.5" fill="${D}"/>
    <path d="M35 64q15 11 30 0" stroke="${D}" stroke-width="3" fill="none" stroke-linecap="round"/>`],
  a9: ['Pinguïn', `<circle cx="50" cy="54" r="29" fill="${D}"/><circle cx="41" cy="57" r="12" fill="${W}"/><circle cx="59" cy="57" r="12" fill="${W}"/>
    <ellipse cx="50" cy="66" rx="14" ry="10" fill="${W}"/><circle cx="42" cy="54" r="3.3" fill="${D}"/><circle cx="58" cy="54" r="3.3" fill="${D}"/>
    <path d="M44 62h12l-6 7z" fill="#f5a524"/>`],
  a10: ['Astronaut', `<rect x="30" y="74" width="40" height="14" rx="5" fill="${W}"/><circle cx="50" cy="50" r="29" fill="${W}"/>
    <rect x="29" y="36" width="42" height="28" rx="14" fill="${D}"/><path d="M37 44q4-4 10-4" stroke="${W}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
    <circle cx="50" cy="80" r="3" fill="rgba(0,0,0,.2)"/>`],
  a11: ['Monstertje', `<path d="M32 34 28 18l14 10zM68 34l4-16-14 10z" fill="${W}"/><rect x="22" y="28" width="56" height="56" rx="26" fill="${W}"/>
    <circle cx="50" cy="50" r="12" fill="rgba(0,0,0,.06)" stroke="${D}" stroke-width="3"/><circle cx="52" cy="50" r="5" fill="${D}"/>
    <path d="M36 68q14 9 28 0" stroke="${D}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="m42 70 3 4 3-3zM55 71l3 3 3-4z" fill="${D}"/>`],
  a12: ['Panda', `<circle cx="30" cy="34" r="11" fill="${D}"/><circle cx="70" cy="34" r="11" fill="${D}"/><circle cx="50" cy="57" r="27" fill="${W}"/>
    <ellipse cx="40" cy="54" rx="7" ry="9.5" transform="rotate(-25 40 54)" fill="${D}"/><ellipse cx="60" cy="54" rx="7" ry="9.5" transform="rotate(25 60 54)" fill="${D}"/>
    <circle cx="41" cy="53" r="2.4" fill="${W}"/><circle cx="59" cy="53" r="2.4" fill="${W}"/><ellipse cx="50" cy="66" rx="4.5" ry="3.3" fill="${D}"/>`],
};

/**
 * Profielfoto: een figuurtje of de eerste letter, op de kleur van het account.
 * `self`: van het eigen account, dan volgt de achtergrond meteen een nieuw gekozen kleur.
 */
function avatar(profile, { self = false } = {}) {
  const color = themeColor(profile.theme);
  const el = h('div', { class: 'avatar', style: `--c:${self ? 'var(--accent)' : color};color:${self ? 'var(--accent-ink)' : inkFor(color)}` });
  const art = AVATAR_ART[profile.avatar];
  if (art) {
    el.classList.add('art');
    el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">${art[1]}</svg>`;
  } else {
    el.textContent = (profile.username?.[0] ?? '?').toUpperCase();
  }
  return el;
}

/** De profielfoto's in het menu bijwerken na een andere keuze. */
function updateNavAvatar() {
  for (const slot of document.querySelectorAll('.nav-avatar')) slot.replaceChildren(avatar(state.user, { self: true }));
}

function profileScreen() {
  const grid = h('div', { class: 'profiles' });
  const hint = h('p', { class: 'muted small profile-hint' });
  let removing = false;
  let confirmId = null;
  const removeButton = h('button', { class: 'btn compact', onclick: () => { removing = !removing; confirmId = null; draw(); } });
  let profiles = [];
  let current = null;

  async function choose(profile) {
    if (removing) {
      if (confirmId !== profile.id) {
        confirmId = profile.id;
        return draw();
      }
      try {
        const res = await api('POST', `/api/profiles/${profile.id}/remove`);
        profiles = res.profiles;
        if (current === profile.id) { state.user = null; current = null; }
        state.profiles = profiles.length;
        toast(`${profile.username} is afgemeld op deze tv.`);
      } catch (err) {
        toast(err.message);
      }
      confirmId = null;
      if (!profiles.length) { removing = false; return renderApp(); }
      return draw();
    }
    try {
      const { user } = await api('POST', `/api/profiles/${profile.id}/select`);
      markProfileChosen();
      state.user = user;
      state.subtitles = undefined;
      renderApp();
    } catch (err) {
      toast(err.message);
    }
  }

  function draw() {
    const tiles = profiles.map((p) => h('button', {
      class: `profile-tile${removing ? ' removing' : ''}${confirmId === p.id ? ' confirm' : ''}`,
      onclick: () => choose(p),
    }, avatar(p), h('span', { class: 'profile-name' }, p.username),
      removing && h('span', { class: 'profile-action' }, confirmId === p.id ? 'Nogmaals OK om af te melden' : 'Afmelden')));
    const add = !removing && h('button', {
      class: 'profile-tile add',
      onclick: () => document.getElementById('app').replaceChildren(pairScreen({ back: true })),
    }, h('div', { class: 'avatar' }, icon('plus')), h('span', { class: 'profile-name' }, 'Account toevoegen'));
    grid.replaceChildren(...tiles, add || '');
    removeButton.textContent = removing ? 'Klaar' : 'Account afmelden';
    hint.textContent = removing ? 'Kies het account dat je van deze tv wilt afmelden. Het account zelf blijft bestaan.' : '';
    setTimeout(() => tvFocus(grid.querySelector('.confirm') ?? grid.querySelector('.profile-tile')), 0);
  }

  api('GET', '/api/profiles').then((data) => {
    profiles = data.profiles;
    current = data.current;
    state.profiles = profiles.length;
    if (!profiles.length) return document.getElementById('app').replaceChildren(pairScreen());
    draw();
  }).catch((err) => hint.replaceChildren(h('span', { class: 'error' }, err.message)));

  return h('div', { class: 'auth profiles-screen' }, h('div', { class: 'profiles-card' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Kijkbox'),
    h('h1', {}, 'Wie kijkt er?'),
    grid, hint, h('div', { class: 'profile-actions' }, removeButton)));
}

/** Op de tv: inloggen met een code die je bevestigt op een ander apparaat. */
function pairScreen({ back = false } = {}) {
  const code = h('div', { class: 'pair-code', 'aria-live': 'polite' }, '···-···');
  const status = h('p', { class: 'muted small' });
  let token = null;

  async function fresh() {
    try {
      const pairing = await api('POST', '/api/pair/start', {});
      token = pairing.token;
      code.textContent = pairing.code;
      status.textContent = 'De code is 5 minuten geldig en vernieuwt daarna vanzelf.';
    } catch (err) {
      status.textContent = err.message;
    }
  }

  async function poll() {
    if (!code.isConnected) return;
    if (token) {
      try {
        const res = await fetch('/api/pair/poll', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, tv: TV }),
        });
        if (res.status === 200) {
          // Opnieuw laden: dan slaat de tv-app de inlog direct op. Het nieuwe profiel is dan gekozen.
          markProfileChosen();
          location.reload();
          return;
        }
        if (res.status === 410) await fresh();
      } catch {
        status.textContent = 'De server is niet bereikbaar.';
      }
    }
    setTimeout(poll, 2000);
  }

  fresh().then(poll);
  const passwordButton = h('button', {
    class: 'btn',
    onclick: () => {
      document.getElementById('app').replaceChildren(loginScreen());
      document.querySelector('.auth input')?.focus();
    },
  }, 'Inloggen met wachtwoord');
  setTimeout(() => passwordButton.focus(), 0);
  const backButton = back && h('button', { class: 'btn', onclick: () => renderApp() }, 'Terug naar profielen');
  return h('div', { class: 'auth' }, h('div', { class: 'auth-card pair' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Kijkbox'),
    h('h1', {}, back ? 'Account toevoegen' : 'Koppel deze tv'),
    h('p', { class: 'muted' }, 'Open Kijkbox op je telefoon of laptop. Ga naar Account en vul bij "Tv koppelen" deze code in:'),
    code, status, h('div', { class: 'actions' }, passwordButton, backButton)));
}

function pairPanel() {
  const input = h('input', { name: 'code', placeholder: 'ABC-123', autocomplete: 'off', autocapitalize: 'characters', maxLength: 9, required: true });
  const form = h('form', {
    class: 'pair-form',
    onsubmit: async (event) => {
      event.preventDefault();
      try {
        await api('POST', '/api/pair/approve', { code: input.value });
        form.reset();
        toast(`De tv is gekoppeld en ingelogd als ${state.user.username}.`);
      } catch (err) {
        toast(err.message);
      }
    },
  }, input, h('button', { class: 'btn', type: 'submit' }, 'Koppelen'));
  return h('section', { class: 'panel' },
    h('h2', {}, 'Tv koppelen'),
    h('p', { class: 'muted small' }, 'Open Kijkbox op je tv en vul hier de code in die daar staat. De tv logt dan in met jouw account, zodat je overal verder kijkt waar je was. Vul alleen een code in die op je eigen tv staat.'),
    form,
    h('p', { class: 'muted small', style: 'margin-top:12px' },
      'Nog geen app op je Google TV of Android TV? Installeer de gratis app Downloader en typ daarin: ',
      h('b', {}, `${location.origin}/tv.apk`),
      '. Het adres van deze server is ', h('b', {}, location.host), '.'));
}

function loginScreen() {
  return authScreen({
    title: 'Inloggen',
    fields: [
      field('Gebruikersnaam', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true, autofocus: true }),
      field('Wachtwoord', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
    ],
    submit: 'Inloggen',
    action: async (values) => {
      const { user } = await api('POST', '/api/login', { ...values, tv: TV });
      if (TV) markProfileChosen();
      state.user = user;
      renderApp();
    },
  });
}

/** Ingelogd met een tijdelijk wachtwoord: eerst een eigen wachtwoord kiezen. */
function newPasswordScreen() {
  return authScreen({
    title: 'Kies je eigen wachtwoord',
    intro: `Welkom ${state.user.username}! Je bent ingelogd met een tijdelijk wachtwoord. Kies nu een wachtwoord dat alleen jij weet.`,
    fields: [
      field('Nieuw wachtwoord (minimaal 8 tekens)', { name: 'next', type: 'password', autocomplete: 'new-password', minLength: 8, required: true, autofocus: true }),
      field('Nog een keer', { name: 'repeat', type: 'password', autocomplete: 'new-password', minLength: 8, required: true }),
    ],
    submit: 'Wachtwoord opslaan',
    action: async ({ next, repeat }) => {
      if (next !== repeat) throw new Error('De twee wachtwoorden zijn niet hetzelfde.');
      await api('POST', '/api/password', { next });
      state.user.mustChangePassword = false;
      renderApp();
      toast('Je wachtwoord is opgeslagen.');
    },
  });
}

function setupScreen() {
  return authScreen({
    title: 'Welkom',
    intro: 'Maak het beheerdersaccount aan. De installatiecode staat in het servervenster op je computer.',
    fields: [
      field('Installatiecode', { name: 'code', autocomplete: 'off', autocapitalize: 'characters', required: true }),
      field('Gebruikersnaam', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true }),
      field('Wachtwoord (minimaal 8 tekens)', { name: 'password', type: 'password', autocomplete: 'new-password', minLength: 8, required: true }),
    ],
    submit: 'Account aanmaken',
    action: async (values) => {
      const { user } = await api('POST', '/api/setup', values);
      state.user = user;
      state.needsSetup = false;
      location.hash = '#/instellingen/bronnen';
      renderApp();
    },
  });
}

// ---- Speler

// Op de tv bedien je de speler met de afstandsbediening, dus daar zonder de knoppen van de browser.
const video = h('video', { controls: !TV, playsInline: true, preload: 'auto' });
video.setAttribute('playsinline', '');
// Een doorzichtige afbeelding, anders toont Android tijdens het laden een grote grijze afspeelknop.
video.poster = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
video.setAttribute('webkit-playsinline', '');
const videoMsg = h('div', { class: 'video-msg' });
const nowTitle = h('div', { class: 'title ellipsis' });
const nowSub = h('div', { class: 'muted small ellipsis' });
const favButton = h('button', { class: 'icon-btn', 'aria-label': 'Favoriet', onclick: () => toggleFav(player.item, favButton) });
const prevButton = h('button', { class: 'icon-btn', 'aria-label': 'Vorige zender', onclick: () => zap(-1) }, icon('up'));
const nextButton = h('button', { class: 'icon-btn', 'aria-label': 'Volgende zender', onclick: () => zap(1) }, icon('down'));
const stageInfo = h('div', { class: 'stage-info' });
// ---- Afspeelbalk op de tv: voortgang, knoppen en "volgende aflevering"
const tvPos = h('span', { class: 'tv-pos' });
const tvTotal = h('span', { class: 'tv-total' });
const tvFill = h('i');
const tvProgress = h('div', { class: 'tv-progress' }, tvPos, h('div', { class: 'tv-track' }, tvFill), tvTotal);
const tvBtn = (cls, label, onclick, ...kids) => h('button', { class: `tv-btn ${cls}`, 'aria-label': label, tabIndex: -1, onclick }, ...kids);
const tvBack10 = tvBtn('', '10 seconden terug', () => tvSeek(-10), icon('replay'), h('span', {}, '10'));
const tvPlay = tvBtn('tv-play', 'Pauze', () => tvTogglePlay());
const tvFwd10 = tvBtn('', '10 seconden vooruit', () => tvSeek(10), h('span', {}, '10'), icon('forward'));
const tvNextEp = tvBtn('tv-next', 'Volgende aflevering', () => tvPlayNext(), icon('next', true), h('span', {}, 'Volgende aflevering'));
// Ondertitels: één knop die wisselt tussen uit, Nederlands en Engels.
const ccButton = h('button', { class: 'icon-btn cc-btn', 'aria-label': 'Ondertitels', onclick: () => cycleSubtitles() });
const tvCc = tvBtn('tv-cc', 'Ondertitels', () => cycleSubtitles());
const tvControls = h('div', { class: 'tv-controls' }, tvBack10, tvPlay, tvFwd10, tvCc, tvNextEp);
const tvHint = h('div', { class: 'tv-hint' });
const stage = h('section', { class: 'stage', 'aria-label': 'Speler' },
  h('div', { class: 'video-wrap' }, video, videoMsg,
    h('button', { class: 'icon-btn close-video', 'aria-label': 'Sluiten', onclick: () => stopPlayback() }, icon('close'))),
  h('div', { class: 'now-bar' },
    h('div', { class: 'grow' }, nowTitle, nowSub, tvProgress, tvControls, tvHint),
    prevButton, nextButton, ccButton, favButton,
    h('button', { class: 'icon-btn', 'aria-label': 'Stoppen', onclick: () => stopPlayback() }, icon('close'))),
  stageInfo);

// ---- Ondertitels (uit het bestand zelf, anders via de server van OpenSubtitles)

const SUB_KEY = 'kijkbox-ondertitels';
const SUB_LANGS = { nl: 'Nederlands', en: 'Engels' };
let subPref = (() => { try { return localStorage.getItem(SUB_KEY) ?? ''; } catch { return ''; } })();
const subTracks = {};
let subRequest = 0;

// Taalcodes waarmee ondertitelsporen in videobestanden worden aangeduid.
const EMBEDDED_LANGS = { nl: ['nl', 'nld', 'dut', 'dutch', 'nederlands'], en: ['en', 'eng', 'english'] };
let subRefresh = null;

const subtitlesPossible = () => Boolean(state.subtitles || player.embeddedSubs?.length)
  && (player.item?.type === 'movie' || player.item?.type === 'episode');

/** Ondertitels die in de film zelf zitten. De server zet ze tijdens het afspelen om. */
async function loadEmbeddedSubs(info, seq) {
  player.embeddedSubs = null;
  player.subsUrl = info.url.startsWith('/s/t/') ? info.url.replace(/index\.m3u8$/, 'subs') : null;
  if (!player.subsUrl || (player.item.type !== 'movie' && player.item.type !== 'episode')) return;
  try {
    const data = await (await fetch(player.subsUrl)).json();
    if (seq !== player.seq || !data.tracks?.length) return;
    player.embeddedSubs = data.tracks;
    loadSubtitles();
  } catch { /* geen ingebouwde ondertitels */ }
}

function updateCcButtons() {
  const show = subtitlesPossible();
  const label = subPref ? subPref.toUpperCase() : 'CC';
  const title = subPref ? `Ondertitels: ${SUB_LANGS[subPref]}` : 'Ondertitels uit';
  for (const b of [ccButton, tvCc]) {
    b.hidden = !show;
    b.style.display = show ? '' : 'none';
    b.textContent = label;
    b.classList.toggle('on', Boolean(subPref));
    b.title = title;
    b.setAttribute('aria-label', title);
  }
}

function clearSubtitles() {
  subRequest += 1;
  clearTimeout(subRefresh);
  for (const track of Object.values(subTracks)) {
    // Van een uitgeschakeld spoor zijn de regels niet te zien en dus ook niet te verwijderen.
    track.mode = 'hidden';
    while (track.cues?.length) track.removeCue(track.cues[0]);
    track.mode = 'disabled';
  }
}

function cycleSubtitles() {
  const order = ['', 'nl', 'en'];
  subPref = order[(order.indexOf(subPref) + 1) % order.length];
  try { localStorage.setItem(SUB_KEY, subPref); } catch {}
  loadSubtitles();
}

/** Haalt de ondertitels voor wat er nu speelt in de gekozen taal en zet ze op het beeld. */
async function loadSubtitles() {
  clearSubtitles();
  updateCcButtons();
  if (!subPref || !subtitlesPossible()) return;
  const mine = subRequest;
  const lang = subPref;
  const item = player.item;
  const embedded = player.embeddedSubs?.find((t) => EMBEDDED_LANGS[lang].includes(t.lang));
  if (embedded) return loadEmbeddedCues(`${player.subsUrl}/${embedded.n}`, lang, item, mine, 0);
  if (!state.subtitles) {
    toast(`Deze film heeft geen ${SUB_LANGS[lang].toLowerCase()}e ondertitels.`);
    return;
  }
  let data;
  try {
    data = await api('GET', `/api/subtitles/${item.id}?lang=${lang}`);
  } catch (err) {
    if (mine === subRequest) toast(err.message);
    return;
  }
  if (mine !== subRequest || player.item !== item) return;
  const track = subTracks[lang] ??= video.addTextTrack('subtitles', SUB_LANGS[lang], lang);
  // Wordt een film halverwege hervat via de server, dan begint het beeld bij 0 op dat punt.
  const base = player.base || 0;
  for (const cue of data.cues) {
    if (cue.end - base <= 0) continue;
    track.addCue(new VTTCue(Math.max(0, cue.start - base), cue.end - base, cue.text));
  }
  track.mode = 'showing';
}

/**
 * Ingebouwde ondertitels: het bestand groeit terwijl de server de film omzet, dus zolang hij
 * niet klaar is komen er elke 15 seconden nieuwe regels bij. Ze lopen gelijk met het beeld.
 */
async function loadEmbeddedCues(url, lang, item, mine, have) {
  let data;
  try {
    data = await (await fetch(url)).json();
  } catch {
    data = { cues: [], done: false };
  }
  if (mine !== subRequest || player.item !== item) return;
  const track = subTracks[lang] ??= video.addTextTrack('subtitles', SUB_LANGS[lang], lang);
  track.mode = 'showing';
  // Zolang het bestand nog groeit, kan de laatste regel half geschreven zijn: die wacht nog even.
  const cues = data.done ? data.cues ?? [] : (data.cues ?? []).slice(0, -1);
  for (const cue of cues.slice(have)) track.addCue(new VTTCue(cue.start, cue.end, cue.text));
  // Nog niets binnen: snel opnieuw kijken. Daarna elke 15 seconden.
  const next = Math.max(have, cues.length);
  if (!data.done) subRefresh = setTimeout(() => loadEmbeddedCues(url, lang, item, mine, next), next ? 15000 : 3000);
}

const player = { item: null, hls: null, seq: 0, mode: null, base: 0, resume: 0, started: false, watchdog: null, lastSave: 0, mediaRetry: false, netRetries: 0, rebufferTimer: null };
let liveList = [];

const NEXT_MODE = { direct: 'remux', remux: 'transcode' };

function showMessage(text, retry) {
  videoMsg.replaceChildren();
  videoMsg.classList.add('show');
  if (retry === undefined) videoMsg.append(h('div', { class: 'spinner' }));
  videoMsg.append(h('div', {}, text));
  if (retry) videoMsg.append(h('button', { class: 'btn compact', onclick: retry }, 'Opnieuw proberen'));
}
const hideMessage = () => videoMsg.classList.remove('show');

function teardownEngine() {
  clearTimeout(player.watchdog);
  stopRebuffer();
  player.hls?.destroy();
  player.hls = null;
  video.removeAttribute('src');
  video.load();
}

function saveProgress(force = false) {
  const { item } = player;
  if (!item || item.type === 'live' || item.type === 'catchup' || !player.started) return;
  const now = Date.now();
  if (!force && now - player.lastSave < 15000) return;
  player.lastSave = now;
  const position = player.base + (video.currentTime || 0);
  if (position < 5) return;
  // Alleen een vaste lengte doorgeven. Tijdens het omzetten groeit de duur nog, en dan zou
  // een aflevering ten onrechte als uitgekeken kunnen tellen.
  const total = tvKnownEnd() && Number.isFinite(video.duration) ? player.base + video.duration : 0;
  api('POST', `/api/progress/${item.id}`, { position, duration: total }).catch(() => {});
}

// ---- Telefoon gedraaid: echt schermvullend. Anders tekent de browser naast de cameranotch
// (bijvoorbeeld op Samsung) een eigen lichte balk. Schermvullend mag alleen na een tik, dus
// dit gebeurt bij het starten van een stream en bij een tik op het beeld.
const phoneLandscape = matchMedia('(max-height: 520px) and (orientation: landscape) and (pointer: coarse)');

function fillScreen() {
  if (TV || !phoneLandscape.matches || !stage.classList.contains('active') || document.fullscreenElement) return;
  stage.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
}

function leaveFullScreen() {
  if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
}

phoneLandscape.addEventListener('change', () => (phoneLandscape.matches ? fillScreen() : leaveFullScreen()));
stage.addEventListener('click', fillScreen);

function stopPlayback() {
  leaveFullScreen();
  clearSubtitles();
  saveProgress(true);
  player.seq += 1;
  player.item = null;
  player.embeddedSubs = null;
  teardownEngine();
  hideMessage();
  stage.classList.remove('active');
  document.querySelector('.shell')?.classList.toggle('idle', true);
  navigator.sendBeacon('/api/play-release', new Blob([JSON.stringify({ cid })], { type: 'application/json' }));
  markPlaying();
}

/** Laat de server weten waarom het afspelen op dit apparaat mislukte. */
function reportFailure() {
  const body = {
    itemId: player.item?.id,
    mode: player.mode,
    native: !player.hls,
    code: video.error?.code ?? player.lastError ?? 'geen beeld binnen 25 sec',
    message: (video.error?.message || player.lastReason || '').replace(/https?:\/\/\S+/g, '[link]').slice(0, 200),
  };
  navigator.sendBeacon('/api/play-error', new Blob([JSON.stringify(body)], { type: 'application/json' }));
}

// Fouten waarbij het beeld zelf niet te tonen is. Alleen dan helpt omzetten (transcoden).
const MEDIA_PROBLEM = /^(bufferAddCodecError|bufferIncompatibleCodecsError|manifestIncompatibleCodecsError|fragParsingError|bufferAppendError|fragDecryptError)$/;

function playbackFailed(seq) {
  if (seq !== player.seq) return;
  reportFailure();
  // Bij live is omzetten zwaar en maakte het het juist erger (de stream liep uit de pas).
  // Gaat het om de afspeellijst of een trage start, probeer dan op dezelfde manier opnieuw.
  const mediaProblem = Boolean(video.error) || MEDIA_PROBLEM.test(player.lastError ?? '');
  const next = player.item?.type === 'live' && !mediaProblem ? null : NEXT_MODE[player.mode];
  const resume = player.base + (video.currentTime || 0) || player.resume;
  teardownEngine();
  if (next) {
    showMessage('Andere afspeelmethode proberen…');
    start(player.item, { mode: next, resume });
  } else if (!player.retried) {
    // Een stream die wordt omgezet, heeft soms een trage start. Geef hem nog één kans.
    player.retried = true;
    showMessage('Opnieuw proberen…');
    start(player.item, { mode: player.requested, resume });
  } else {
    showMessage('Deze stream speelt nu niet af.', () => start(player.item, { resume }));
  }
}

function attach(info, seq) {
  player.mode = info.mode;
  player.base = info.base || 0;
  player.watchdog = setTimeout(() => playbackFailed(seq), 25000);

  const useNative = info.kind === 'file' || !window.Hls?.isSupported() || isAppleTouch();
  if (useNative) {
    video.src = info.url;
  } else {
    const hls = new Hls({
      backBufferLength: 60,
      // Ruim achter live blijven: de provider levert met horten en stoten, en zo overbrugt de
      // buffer de stille stukken in plaats van dat het beeld vastloopt (zie LIVE_DELAY op de server).
      ...(player.item.type === 'live' ? { liveSyncDuration: 30, maxBufferLength: 40 } : { liveSyncDurationCount: 3 }),
      // Live heeft geen einde, dus de speler toont ook geen tijdbalk die vol kan lopen.
      liveDurationInfinity: player.item.type === 'live',
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 5,
      fragLoadingMaxRetry: 5,
    });
    player.hls = hls;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || seq !== player.seq) return;
      console.warn('Afspeelfout', data.type, data.details, data.response?.code ?? '', data.error?.message ?? '');
      player.lastError = data.details;
      player.lastReason = data.reason || data.error?.message || '';
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !player.mediaRetry) {
        player.mediaRetry = true;
        hls.recoverMediaError();
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && player.started && player.netRetries < 3) {
        player.netRetries += 1;
        setTimeout(() => seq === player.seq && hls.startLoad(), 1500);
      } else {
        playbackFailed(seq);
      }
    });
    hls.loadSource(info.url);
    hls.attachMedia(video);
  }
  loadSubtitles();
  loadEmbeddedSubs(info, seq);
  video.play().catch((err) => {
    // Sommige browsers wachten op een tik voordat er geluid mag klinken. De stream is dan niet stuk.
    if (err.name === 'NotAllowedError' && seq === player.seq) {
      clearTimeout(player.watchdog);
      hideMessage();
    }
  });
}

/** iPhones en iPads spelen HLS het betrouwbaarst met de ingebouwde speler. */
function isAppleTouch() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function start(item, { mode = 'auto', resume = 0 } = {}) {
  saveProgress(true);
  const seq = ++player.seq;
  if (player.item?.id !== item.id) {
    player.mediaRetry = false;
    player.netRetries = 0;
    player.retried = false;
  }
  player.lastError = null;
  player.item = item;
  player.embeddedSubs = null;
  player.requested = mode;
  player.started = false;
  player.resume = resume;
  teardownEngine();
  stage.classList.add('active');
  fillScreen();
  document.querySelector('.shell')?.classList.remove('idle');
  showMessage('Laden…');
  updateNowBar(item);
  markPlaying();
  if (TV) {
    tvLoadNext(item);
    tvShowBar();
  }
  if (item.type === 'live') localStorage.setItem(LAST_CHANNEL_KEY, String(item.id));
  if (item.catchup) toast(`Terugkijken: ${item.name}`);
  try {
    // Terugkijken: dezelfde zender, maar een uitzending van eerder.
    const info = item.catchup
      ? await api('POST', `/api/catchup/${item.id}`, { cid, start: item.catchup.start, stop: item.catchup.stop, offset: resume, mode: mode === 'transcode' ? 'transcode' : 'remux' })
      : await api('POST', `/api/play/${item.id}`, { mode, cid, start: resume, native: isAppleTouch() });
    if (seq !== player.seq) return;
    attach(info, seq);
  } catch (err) {
    if (seq !== player.seq) return;
    if (mode !== 'transcode' && err.message === 'De stream kon niet worden omgezet.') {
      start(item, { mode: 'transcode', resume });
    } else if (!player.retried) {
      // Bij snel zappen is de ene verbinding van de provider soms nog even bezet. Probeer het nog één keer.
      player.retried = true;
      showMessage('Opnieuw proberen…');
      setTimeout(() => seq === player.seq && start(item, { mode, resume }), 1500);
    } else {
      showMessage(err.message, () => start(item, { resume }));
    }
  }
}

function updateNowBar(item) {
  nowTitle.textContent = item.season ? `S${item.season} E${item.episode} · ${clean(item.name)}` : clean(item.name);
  nowSub.textContent = item.now?.title || clean(item.group);
  const live = item.type === 'live';
  prevButton.hidden = nextButton.hidden = !live;
  prevButton.style.display = nextButton.style.display = live ? '' : 'none';
  clearSubtitles();
  updateCcButtons();
  favButton.replaceChildren(icon('star', item.fav));
  favButton.classList.toggle('on', Boolean(item.fav));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: item.name, artist: item.now?.title || 'Kijkbox' });
  }
  stageInfo.replaceChildren();
  if (live) {
    api('GET', `/api/items/${item.id}`).then(({ programmes = [] }) => {
      if (player.item?.id !== item.id) return;
      stageInfo.replaceChildren(...programmes.slice(0, 12).map((p) => h('div', { class: 'schedule-item' },
        h('span', { class: 'muted' }, time(p.start)),
        h('div', { class: 'grow' }, h('div', {}, p.title), p.descr && h('div', { class: 'muted small ellipsis' }, p.descr)))));
    }).catch(() => {});
  }
}

function markPlaying() {
  for (const row of document.querySelectorAll('.row[data-id], .live-tile[data-id]')) {
    row.classList.toggle('playing', Number(row.dataset.id) === player.item?.id);
  }
}

function zap(direction) {
  if (!liveList.length) return;
  const index = liveList.findIndex((item) => item.id === player.item?.id);
  const target = liveList[(index + direction + liveList.length) % liveList.length];
  start(target);
  document.querySelector(`.row[data-id="${target.id}"], .live-tile[data-id="${target.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

video.addEventListener('loadedmetadata', () => {
  // Bij omgezette streams begint de video al op de juiste plek.
  if (player.resume && !player.base) video.currentTime = player.resume;
});
video.addEventListener('playing', () => {
  clearTimeout(player.watchdog);
  player.started = true;
  player.netRetries = 0;
  hideMessage();
});
video.addEventListener('loadeddata', () => clearTimeout(player.watchdog));
video.addEventListener('error', () => {
  if (player.item && !player.hls && video.getAttribute('src')) playbackFailed(player.seq);
  // Een beschadigd beeldje in een live-stream legt de video stil (hij gaat op pauze, dus de
  // stilstandbewaking ziet het niet). Start de stream dan opnieuw; restartLive begrenst dat.
  else if (player.hls && player.started && player.item?.type === 'live') {
    console.warn('Beeldfout in live-stream, opnieuw starten', video.error?.code ?? '');
    restartLive();
  }
});
video.addEventListener('timeupdate', () => {
  saveProgress();
  if (!TV) return;
  tvCheckNext();
  if (stage.classList.contains('show-bar')) tvUpdateTime();
});
// Bij pauze blijft de balk staan; gaat het weer spelen, dan verdwijnt hij na een paar seconden.
for (const name of ['play', 'pause']) {
  video.addEventListener(name, () => {
    if (TV && stage.classList.contains('show-bar')) tvShowBar(tvInControls() ? document.activeElement : undefined);
  });
}
video.addEventListener('pause', () => saveProgress(true));
video.addEventListener('ended', () => {
  const { item } = player;
  if (item?.type === 'live') restartLive();
  else if (item) {
    api('POST', `/api/progress/${item.id}`, { finished: true }).catch(() => {});
    if (TV && tvNext) {
      tvNextShown = true;
      tvShowBar(tvNextEp);
    }
  }
});

// ---- Live: bij een lege buffer even bufferen in plaats van telkens kort haperen.
// De provider levert met horten en stoten. Loopt de buffer leeg, dan wacht de speler tot er
// weer REBUFFER_S seconden klaarstaan én hij minstens REBUFFER_MIN_MS heeft gewacht. Daardoor
// komt hij verder achter live te zitten, en die voorsprong vangt de volgende stille stukken op.
// Meestal is dit maar één keer nodig. Zit hij al ver achter live, dan wacht hij niet extra lang,
// anders loopt hij uit de afspeellijst van de server (die zo'n 1,5 tot 2,5 minuut bewaart).
const REBUFFER_S = 12;
const REBUFFER_MIN_MS = 10000;
const REBUFFER_MAX_MS = 25000;
const REBUFFER_MAX_BEHIND = 45;

function behindLive() {
  const { seekable } = video;
  return seekable.length ? seekable.end(seekable.length - 1) - video.currentTime : 0;
}

function bufferedAhead() {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.3 && t < video.buffered.end(i)) return video.buffered.end(i) - t;
  }
  return 0;
}

function stopRebuffer() {
  clearInterval(player.rebufferTimer);
  player.rebufferTimer = null;
}

video.addEventListener('waiting', () => {
  if (!player.hls || !player.started || player.item?.type !== 'live' || video.seeking || player.rebufferTimer) return;
  const seq = player.seq;
  const began = Date.now();
  const minWait = behindLive() < REBUFFER_MAX_BEHIND ? REBUFFER_MIN_MS : 0;
  video.pause();
  showMessage('Bufferen…');
  player.rebufferTimer = setInterval(() => {
    if (seq !== player.seq) return stopRebuffer();
    const waited = Date.now() - began;
    if ((bufferedAhead() >= REBUFFER_S && waited >= minWait) || waited > REBUFFER_MAX_MS) {
      stopRebuffer();
      hideMessage();
      video.play().catch(() => {});
    }
  }, 500);
});
// Drukt iemand zelf op afspelen tijdens het bufferen, dan gaat dat voor.
video.addEventListener('play', () => {
  if (player.rebufferTimer) {
    stopRebuffer();
    hideMessage();
  }
});

// ---- Live-streams weer op gang brengen als het beeld stilvalt

const STALL_MS = 15000;
const MAX_RESTARTS = 5;
let lastTime = 0;
let lastMove = 0;
let restarts = [];

function restartLive() {
  const { item } = player;
  const now = Date.now();
  restarts = restarts.filter((at) => now - at < 300000);
  if (restarts.length >= MAX_RESTARTS) {
    teardownEngine();
    showMessage('De stream blijft haperen.', () => {
      restarts = [];
      start(item);
    });
    return;
  }
  restarts.push(now);
  lastMove = now;
  start(item, { mode: player.requested });
}

setInterval(() => {
  const now = Date.now();
  if (video.currentTime !== lastTime || video.paused || !player.started || player.item?.type !== 'live') {
    lastTime = video.currentTime;
    lastMove = now;
  } else if (now - lastMove > STALL_MS) {
    console.warn('Stream staat stil, opnieuw starten');
    restartLive();
  }
}, 2000);
window.addEventListener('pagehide', () => {
  navigator.sendBeacon('/api/play-release', new Blob([JSON.stringify({ cid })], { type: 'application/json' }));
});

document.addEventListener('keydown', (event) => {
  if (TV || event.target.closest('input, textarea, select') || !player.item) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (player.item.type !== 'live') return;
    event.preventDefault();
    zap(event.key === 'ArrowUp' ? -1 : 1);
  } else if (event.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else video.requestFullscreen?.();
  } else if (event.key === 'm') {
    video.muted = !video.muted;
  } else if (event.key === ' ' && event.target === document.body) {
    event.preventDefault();
    if (video.paused) video.play();
    else video.pause();
  }
});

async function toggleFav(item, button) {
  if (!item) return;
  const next = !item.fav;
  await api(next ? 'POST' : 'DELETE', `/api/favorites/${item.id}`);
  item.fav = next;
  if (player.item?.id === item.id) {
    player.item.fav = next;
    favButton.replaceChildren(icon('star', next));
    favButton.classList.toggle('on', next);
  }
  if (button && button !== favButton) {
    button.replaceChildren(icon('star', next));
    button.classList.toggle('on', next);
  }
}

// ---- Eindeloos doorscrollen

/** Laadt een lijst in stukjes, zodat ook playlists met tienduizenden zenders vlot blijven. */
function pagedList(container, load, render) {
  let offset = 0;
  let busy = false;
  let more = true;
  let token = 0;
  const sentinel = h('div', { class: 'sentinel' });

  async function next() {
    if (busy || !more) return;
    busy = true;
    const mine = token;
    try {
      const { items, more: hasMore } = await load(offset);
      if (mine !== token) return;
      offset += items.length;
      more = hasMore;
      render(items, offset === items.length);
      if (offset === items.length) tvListLoaded();
      if (!more) observer.disconnect();
      else {
        observer.unobserve(sentinel);
        observer.observe(sentinel);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      if (mine === token) busy = false;
    }
  }

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) next();
  }, { rootMargin: '600px' });

  const reset = () => {
    token += 1;
    offset = 0;
    more = true;
    busy = false;
    container.replaceChildren();
    container.after(sentinel);
    observer.disconnect();
    next();
  };
  return {
    reset,
    stop: () => observer.disconnect(),
    // Na terugkomen op een bewaarde pagina: verder laden zodra je verder scrolt.
    resume: () => { if (more) observer.observe(sentinel); },
  };
}

// ---- Weergaven

const emptySources = () => h('div', { class: 'empty' },
  h('p', {}, 'Er is nog geen bron toegevoegd.'),
  state.user.role === 'admin'
    ? h('a', { class: 'btn primary', href: '#/instellingen/bronnen' }, 'Bron toevoegen')
    : h('p', { class: 'small' }, 'Vraag de beheerder om een IPTV-bron toe te voegen.'));

function groupSelect(groups, selected, onGroup) {
  return h('select', { class: 'group-select', 'aria-label': 'Categorie', onchange: (e) => onGroup(e.target.value) },
    h('option', { value: '' }, 'Alle categorieën'),
    groups.map((g) => h('option', { value: g.name, selected: g.name === selected }, `${g.label ?? g.name} (${g.count})`)));
}

function filterBar({ groups, selected, onGroup, placeholder, q, onSearch, column, country, extra }) {
  const search = h('input', {
    type: 'search', placeholder, value: q, 'aria-label': placeholder,
    oninput: debounce((e) => onSearch(e.target.value.trim()), 250),
  });
  const classes = ['filters', column && 'has-column', country && 'three', extra && 'with-extra'].filter(Boolean).join(' ');
  return h('div', { class: classes }, country, groupSelect(groups, selected, onGroup), search, extra);
}

const SORTS = [['', 'Nieuw toegevoegd'], ['year', 'Releasejaar'], ['rating', 'Beoordeling'], ['az', 'A–Z']];

function sortSelect(current, onPick) {
  return h('select', { 'aria-label': 'Sorteren', onchange: (e) => onPick(e.target.value) },
    SORTS.map(([value, label]) => h('option', { value, selected: value === current }, label)));
}

// ---- Landkeuze voor Live en Gids

/** Haalt de landen en de categorieën van het gekozen land op. */
async function loadLiveFilters() {
  // Een probleem met de landenlijst mag de zenders zelf niet blokkeren.
  const countries = await api('GET', '/api/countries?type=live').catch(() => []);
  // Staan er nergens landcodes in de zenderlijst, dan valt er niets te kiezen.
  const usable = countries.some((c) => c.code !== 'OVERIG') ? countries : [];
  if (!usable.some((c) => c.code === liveFilter.country)) liveFilter.country = '';
  const query = liveFilter.country ? `&country=${encodeURIComponent(liveFilter.country)}` : '';
  return { countries: usable, groups: await api('GET', `/api/groups?type=live${query}`) };
}

function chooseCountry(code) {
  liveFilter.country = code;
  liveFilter.group = '';
  localStorage.setItem(COUNTRY_KEY, code);
}

/** Keuzelijst met landen. Zonder `current` en `onPick` hoort hij bij Live en de Gids. */
function countrySelect(countries, onChange, current = liveFilter.country, onPick = chooseCountry) {
  const options = countries.map((c) => h('option', { value: c.code, selected: c.code === current }, `${c.label} (${c.count})`));
  // Nederland blijft de bovenste keuze, ook boven "Alle landen".
  options.splice(countries[0].code === 'NL' ? 1 : 0, 0, h('option', { value: '', selected: !current }, 'Alle landen'));
  return h('select', {
    'aria-label': 'Land',
    onchange: (e) => {
      onPick(e.target.value);
      onChange();
    },
  }, options);
}

function groupColumn(groups, selected, onGroup) {
  const buttons = [{ name: '', label: 'Alle categorieën' }, ...groups].map((g) => h('button', {
    class: g.name === selected ? 'active' : '',
    onclick: (e) => {
      e.currentTarget.parentElement.querySelector('.active')?.classList.remove('active');
      e.currentTarget.classList.add('active');
      onGroup(g.name);
    },
  }, h('span', { class: 'ellipsis' }, g.label ?? g.name), g.count ? h('span', { class: 'small' }, String(g.count)) : null));
  return h('nav', { class: 'groups', 'aria-label': 'Categorieën' }, buttons);
}

function channelRow(item) {
  const star = h('button', {
    class: `icon-btn${item.fav ? ' on' : ''}`, 'aria-label': 'Favoriet',
    onclick: () => toggleFav(item, star).catch((err) => toast(err.message)),
  }, icon('star', item.fav));
  const progress = item.now && Math.min(100, ((Date.now() - item.now.start) / (item.now.stop - item.now.start)) * 100);
  return h('div', { class: `row${player.item?.id === item.id ? ' playing' : ''}`, 'data-id': item.id },
    h('button', { class: 'row-main', onclick: () => start(item) },
      logoBox(item),
      h('div', { class: 'grow' },
        h('div', { class: 'name ellipsis' }, clean(item.name)),
        h('div', { class: 'sub ellipsis' }, item.now?.title ?? clean(item.group)),
        item.now && h('div', { class: 'meter' }, h('i', { style: `width:${progress}%` })))),
    star);
}

// Live als lijst of als tegels (per apparaat onthouden).
const LIVE_LAYOUT_KEY = 'kijkbox-live-weergave';
const timeOf = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

function liveTile(item) {
  const progress = item.now && Math.min(100, ((Date.now() - item.now.start) / (item.now.stop - item.now.start)) * 100);
  return h('button', { class: `live-tile${player.item?.id === item.id ? ' playing' : ''}`, 'data-id': item.id, onclick: () => start(item) },
    h('div', { class: 'live-tile-logo' }, item.logo
      ? h('img', { src: item.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(clean(item.name).slice(0, 2)) })
      : clean(item.name).slice(0, 2)),
    h('div', { class: 'name ellipsis' }, clean(item.name)),
    h('div', { class: 'sub ellipsis' }, item.now?.title ?? clean(item.group)),
    item.now && h('div', { class: 'meter' }, h('i', { style: `width:${progress}%` })),
    item.next && h('div', { class: 'next ellipsis' }, `${timeOf(item.next.start)} ${item.next.title}`));
}

async function liveView(container) {
  let paged = null;

  async function draw() {
    paged?.stop();
    const { countries, groups } = await loadLiveFilters();
    if (!groups.length) {
      container.replaceChildren(emptySources());
      return;
    }

    const grid = (localStorage.getItem(LIVE_LAYOUT_KEY) ?? 'list') === 'grid';
    const rows = h('div', { class: grid ? 'live-grid' : 'rows' });
    const noResults = () => h('div', { class: 'empty' },
      h('p', {}, 'Geen zenders gevonden.'),
      liveFilter.q && liveFilter.country && h('button', {
        class: 'btn compact',
        onclick: () => {
          chooseCountry('');
          draw();
        },
      }, 'Zoek in alle landen'));
    paged = pagedList(rows,
      (offset) => {
        const params = new URLSearchParams({ type: 'live', offset, limit: 80 });
        if (liveFilter.country) params.set('country', liveFilter.country);
        if (liveFilter.group) params.set('group', liveFilter.group);
        if (liveFilter.q) params.set('q', liveFilter.q);
        if (grid) params.set('next', '1');
        return api('GET', `/api/items?${params}`);
      },
      (items, first) => {
        if (first) liveList = [];
        liveList.push(...items);
        if (first && !items.length) rows.append(noResults());
        rows.append(...items.map(grid ? liveTile : channelRow));
      });

    const onGroup = (value) => {
      liveFilter.group = value;
      viewEl.scrollTop = 0;
      paged.reset();
    };
    container.replaceChildren(h('div', { class: 'page' },
      filterBar({
        groups, selected: liveFilter.group, onGroup, placeholder: 'Zoek zender', q: liveFilter.q, column: true,
        country: countries.length ? countrySelect(countries, draw) : null,
        onSearch: (q) => { liveFilter.q = q; paged.reset(); },
        extra: h('button', {
          class: 'icon-btn layout-btn',
          'aria-label': grid ? 'Als lijst tonen' : 'Als tegels tonen',
          title: grid ? 'Als lijst tonen' : 'Als tegels tonen',
          onclick: () => {
            localStorage.setItem(LIVE_LAYOUT_KEY, grid ? 'list' : 'grid');
            draw();
          },
        }, icon(grid ? 'list' : 'grid')),
      }),
      h('div', { class: 'browse with-groups' },
        groupColumn(groups, liveFilter.group, onGroup),
        h('div', {}, rows))));
    viewEl.scrollTop = 0;
    paged.reset();
  }

  await draw();
  return () => paged?.stop();
}

/** Meteen verder kijken vanaf een poster, zonder eerst de detailpagina te openen. */
async function resumeFromPoster(item) {
  try {
    const full = await api('GET', `/api/items/${item.id}`);
    start(full, { resume: full.position || 0 });
  } catch (err) {
    toast(err.message);
  }
}

/**
 * Poster van een film, serie of aflevering. Ben je ermee begonnen (`resume`, of er is voortgang),
 * dan staat er een play-knop in het midden: die hervat meteen. Ernaast klikken opent de detailpagina.
 */
function posterCard(item, { resume = false } = {}) {
  const playable = (item.type === 'movie' || item.type === 'episode') && (resume || item.position > 0);
  const percent = item.position && item.duration ? (item.position / item.duration) * 100 : 0;
  // Bij een aflevering in "Verder kijken": de serie als titel, de aflevering eronder.
  const title = item.seriesName ? clean(item.seriesName) : clean(item.name);
  const rating = Number(item.rating) > 0 ? `★ ${Number(item.rating).toFixed(1).replace('.0', '')}` : null;
  const sub = item.seriesName && item.season
    ? `S${item.season} E${item.episode}`
    : [item.year, rating].filter(Boolean).join(' · ') || null;
  const card = h('a', { class: 'poster', href: `#/item/${item.id}`, 'data-resume': playable ? '1' : undefined },
    h('div', { class: 'art' }, title,
      playable && h('span', {
        class: 'poster-play', role: 'button', tabindex: '-1',
        title: item.position ? `Verder kijken vanaf ${clock(item.position)}` : 'Afspelen',
        'aria-label': item.position ? `${title} verder kijken` : `${title} afspelen`,
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          resumeFromPoster(item);
        },
      }, icon('play', true)),
      item.logo && h('img', { src: item.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }),
      item.versions > 1 && h('span', { class: 'versions', title: `${item.versions} versies in verschillende talen` }, `${item.versions} talen`),
      percent > 0 && h('div', { class: 'meter' }, h('i', { style: `width:${percent}%` }))),
    h('div', { class: 'label' }, title),
    sub && h('div', { class: 'poster-sub' }, sub));
  // Op de tv: met de play-toets van de afstandsbediening meteen verder kijken.
  if (playable) card.resumeItem = item;
  return card;
}

// ---- Home: verder kijken, laatste zender en favorieten

const LAST_CHANNEL_KEY = 'kijkbox-laatste-zender';

function channelTile(item, badge) {
  const progress = item.now && Math.min(100, ((Date.now() - item.now.start) / (item.now.stop - item.now.start)) * 100);
  return h('button', { class: 'tile', 'data-id': item.id, onclick: () => start(item) },
    h('div', { class: 'tile-head' }, logoBox(item), badge && h('span', { class: 'pill' }, badge)),
    h('div', { class: 'name ellipsis' }, clean(item.name)),
    h('div', { class: 'sub ellipsis' }, item.now?.title ?? clean(item.group)),
    item.now && h('div', { class: 'meter' }, h('i', { style: `width:${progress}%` })));
}

/** Rij die je zijwaarts doorloopt. Op een computer met pijltjes ernaast. */
function shelf(title, row) {
  if (TV || !row.classList.contains('shelf-row')) return h('section', { class: 'shelf' }, h('h2', {}, title), row);
  const step = (direction) => row.scrollBy({ left: direction * Math.max(200, row.clientWidth * 0.8), behavior: 'smooth' });
  const prev = h('button', { class: 'icon-btn shelf-arrow', 'aria-label': 'Naar links', onclick: () => step(-1) }, icon('back'));
  const next = h('button', { class: 'icon-btn shelf-arrow', 'aria-label': 'Naar rechts', onclick: () => step(1) }, icon('right'));
  const controls = h('div', { class: 'shelf-arrows' }, prev, next);
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    controls.hidden = max <= 4;
    prev.disabled = row.scrollLeft <= 4;
    next.disabled = row.scrollLeft >= max - 4;
  };
  row.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(row);
  requestAnimationFrame(update);
  return h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', {}, title), controls), row);
}

async function removeFromContinue(item) {
  await api('DELETE', `/api/progress/${item.id}`);
  toast(item.seriesName || item.type === 'series' || item.parentId ? 'Serie uit Verder kijken gehaald.' : 'Uit Verder kijken gehaald.');
}


// Na een update: één keer per account (op dit apparaat) laten zien wat er nieuw is.
const seenKey = () => `kijkbox-nieuw-gezien-${state.user?.id}`;

async function loadWhatsNew(slot) {
  let data;
  try {
    data = await api('GET', '/api/whats-new');
  } catch {
    return;
  }
  let seen = null;
  try { seen = localStorage.getItem(seenKey()); } catch {}
  if (!data.version || seen === data.version || !slot.isConnected) return;
  const close = h('button', {
    class: 'btn compact',
    onclick: () => {
      try { localStorage.setItem(seenKey(), data.version); } catch {}
      slot.replaceChildren();
      if (TV) tvFocusDefault();
    },
  }, 'Begrepen');
  slot.replaceChildren(h('section', { class: 'whats-new' },
    h('div', { class: 'grow' },
      h('b', {}, `Kijkbox is bijgewerkt naar versie ${data.version}`),
      data.notes && h('pre', { class: 'update-notes' }, data.notes)),
    close));
}

// Uitgelicht bovenaan Home: een recente film met een goede beoordeling en een achtergrondbeeld.
const FEATURED_KEY = 'kijkbox-uitgelicht';

async function loadFeatured(slot) {
  let pick = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(FEATURED_KEY) || 'null');
    if (saved && Date.now() - saved.at < 3 * 3600 * 1000) pick = saved.item;
  } catch {}
  if (!pick) {
    try {
      const { fresh } = await api('GET', '/api/highlights?type=movie');
      for (const candidate of fresh.filter((i) => Number(i.rating) >= 6.5).slice(0, 5)) {
        const { backdrop } = await api('GET', `/api/items/${candidate.id}/backdrop`);
        if (!backdrop) continue;
        const full = await api('GET', `/api/items/${candidate.id}`);
        pick = { id: full.id, name: full.name, year: full.year, rating: full.rating, plot: full.plot, backdrop, versions: full.versions?.length };
        break;
      }
      sessionStorage.setItem(FEATURED_KEY, JSON.stringify({ at: Date.now(), item: pick }));
    } catch {
      return;
    }
  }
  if (!pick || !slot.isConnected) return;
  const img = h('img', { src: pick.backdrop, alt: '', onerror: () => slot.replaceChildren() });
  const rating = Number(pick.rating) > 0 ? `★ ${Number(pick.rating).toFixed(1).replace('.0', '')}` : null;
  slot.replaceChildren(h('section', { class: 'featured' }, img,
    h('div', { class: 'featured-text' },
      h('span', { class: 'pill' }, 'Uitgelicht'),
      h('h2', {}, clean(pick.name)),
      h('p', { class: 'muted small' }, [pick.year, rating, pick.versions > 1 && `${pick.versions} talen`].filter(Boolean).join(' · ')),
      pick.plot && h('p', { class: 'featured-plot' }, pick.plot),
      h('a', { class: 'btn primary', href: `#/item/${pick.id}` }, icon('play', true), 'Bekijken'))));
  img.addEventListener('load', () => slot.querySelector('.featured')?.classList.add('loaded'));
}

async function homeView(container) {
  const lastId = Number(localStorage.getItem(LAST_CHANNEL_KEY)) || null;
  const [continuing, favorites, last] = await Promise.all([
    api('GET', '/api/continue'),
    api('GET', '/api/items?fav=1&limit=200'),
    lastId ? api('GET', `/api/items/${lastId}`).catch(() => null) : null,
  ]);
  const favChannels = favorites.items.filter((i) => i.type === 'live' && i.id !== last?.id);
  const channels = [...(last?.type === 'live' ? [last] : []), ...favChannels];
  const media = favorites.items.filter((i) => i.type !== 'live');
  // Omhoog/omlaag tijdens het kijken gaat dan langs deze zenders.
  if (channels.length) liveList = channels;

  const page = h('div', { class: 'page home' });
  const news = h('div', { class: 'whats-new-slot' });
  const featured = h('div', { class: 'featured-slot' });
  page.append(news, featured);
  loadWhatsNew(news);
  loadFeatured(featured);
  if (continuing.length) page.append(shelf('Verder kijken', h('div', { class: 'shelf-row' }, continuing.map((item) => posterCard(item, { resume: true })))));
  if (channels.length) {
    page.append(shelf('Zenders', h('div', { class: 'shelf-row channels' },
      channels.map((item) => channelTile(item, item.id === last?.id ? 'Laatst gekeken' : null)))));
  }
  if (media.length) page.append(shelf('Mijn films en series', h('div', { class: 'shelf-row' }, media.map(posterCard))));
  if (!page.childElementCount) {
    page.append(h('div', { class: 'empty' },
      h('p', {}, 'Hier verschijnt wat je aan het kijken bent, je laatste zender en je favorieten. Kies de ster bij een zender, film of serie om hem hier te bewaren.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/live' }, 'Naar Live'),
        h('a', { class: 'btn', href: '#/series' }, 'Naar Series'))));
  }
  container.replaceChildren(page);
}

// Films en Series worden bewaard als je een titel opent. Ga je terug, dan sta je weer op dezelfde
// plek, met alles wat al geladen was, je zoekopdracht en filters.
const posterCache = {};
const POSTER_CACHE_MS = 30 * 60 * 1000;

async function posterView(container, type, { returning = false } = {}) {
  const cached = posterCache[type];
  if (returning && cached && Date.now() - cached.at < POSTER_CACHE_MS) {
    container.replaceChildren(cached.page);
    viewEl.scrollTop = cached.scroll;
    // Posters buiten beeld krijgen na terugzetten een geschatte hoogte, waardoor alles iets
    // verschuift. Daarom uitlijnen op de titel die je aanklikte, op dezelfde plek in beeld.
    const anchor = cached.from && cached.page.querySelector(`a.poster[href="${cached.from}"]`);
    const align = () => {
      if (!anchor?.isConnected || cached.anchorTop === undefined) return;
      viewEl.scrollTop += anchor.getBoundingClientRect().top - viewEl.getBoundingClientRect().top - cached.anchorTop;
    };
    align();
    requestAnimationFrame(() => { align(); requestAnimationFrame(align); });
    cached.paged.resume();
    // Op de tv de selectie terug op de titel die je net open had.
    if (TV) setTimeout(() => tvFocus(cached.page.querySelector(`a.poster[href="${cached.from}"]`) ?? cached.page.querySelector('.poster')), 0);
    return cached.cleanup;
  }
  delete posterCache[type];
  const filter = browseState[type];
  const countryKey = `${COUNTRY_KEY}-${type}`;
  // Standaard alle landen: zoeken toont dan Nederlands bovenaan en Engels daarna.
  if (filter.country === undefined) filter.country = localStorage.getItem(countryKey) ?? '';
  const countries = await api('GET', `/api/countries?type=${type}`).catch(() => []);
  const usable = countries.some((c) => c.code !== 'OVERIG') ? countries : [];
  if (!usable.some((c) => c.code === filter.country)) filter.country = '';
  const loadGroups = () => api('GET', `/api/groups?type=${type}${filter.country ? `&country=${encodeURIComponent(filter.country)}` : ''}`);
  let groups = await loadGroups();
  if (!groups.length && !filter.country) return container.replaceChildren(emptySources());
  const grid = h('div', { class: 'posters' });
  const paged = pagedList(grid,
    (offset) => {
      const params = new URLSearchParams({ type, offset, limit: 60 });
      if (filter.country) params.set('country', filter.country);
      if (filter.group) params.set('group', filter.group);
      if (filter.q) params.set('q', filter.q);
      if (filter.sort) params.set('sort', filter.sort);
      return api('GET', `/api/items?${params}`);
    },
    (items, first) => {
      if (first && !items.length) grid.append(h('p', { class: 'empty' }, 'Niets gevonden.'));
      grid.append(...items.map(posterCard));
    });
  if (filter.sort === undefined) filter.sort = localStorage.getItem(`kijkbox-sorteren-${type}`) ?? '';

  // Nieuwe releases en aanbevelingen staan boven de lijst, zolang je niet filtert of zoekt.
  const highlights = h('div', { class: 'highlights' });
  let latest = 0;
  async function loadHighlights() {
    const mine = ++latest;
    highlights.replaceChildren();
    if (filter.group || filter.q || filter.sort) return;
    const country = filter.country ? `&country=${encodeURIComponent(filter.country)}` : '';
    let data;
    try {
      data = await api('GET', `/api/highlights?type=${type}${country}`);
    } catch {
      return;
    }
    if (mine !== latest || filter.group || filter.q || filter.sort) return;
    const row = (items) => h('div', { class: 'shelf-row' }, items.map(posterCard));
    if (data.fresh.length) highlights.append(shelf('Nieuwe releases', row(data.fresh)));
    if (data.recommended.length) highlights.append(shelf(data.personal ? 'Aanbevolen voor jou' : 'Aanbevolen', row(data.recommended)));
    if (!highlights.childElementCount) return;
    highlights.append(h('h2', { class: 'all-heading' }, type === 'movie' ? 'Alle films' : 'Alle series'));
    // Op de tv begin je bovenaan bij de nieuwe releases, niet in de grote lijst eronder.
    if (TV && document.activeElement === grid.querySelector('.poster')) tvFocus(highlights.querySelector('.poster'));
  }

  const refresh = () => {
    paged.reset();
    loadHighlights();
  };
  const bar = () => filterBar({
    groups, selected: filter.group, placeholder: type === 'movie' ? 'Zoek film' : 'Zoek serie', q: filter.q,
    country: usable.length ? countrySelect(usable, onCountry, filter.country, (code) => {
      filter.country = code;
      filter.group = '';
      localStorage.setItem(countryKey, code);
    }) : null,
    onGroup: (value) => { filter.group = value; refresh(); },
    onSearch: (q) => { filter.q = q; refresh(); },
    extra: sortSelect(filter.sort, (value) => {
      filter.sort = value;
      localStorage.setItem(`kijkbox-sorteren-${type}`, value);
      refresh();
    }),
  });
  let filters = bar();
  async function onCountry() {
    groups = await loadGroups().catch(() => []);
    const next = bar();
    filters.replaceWith(next);
    filters = next;
    refresh();
  }
  const page = h('div', { class: 'page' }, filters, highlights, grid);
  container.replaceChildren(page);
  refresh();
  const entry = { page, paged, at: Date.now(), scroll: 0, from: '' };
  // Bij het verlaten de plek onthouden. Op dat moment staat de nieuwe link al in de adresbalk.
  entry.cleanup = () => {
    paged.stop();
    entry.scroll = viewEl.scrollTop;
    entry.at = Date.now();
    entry.from = location.hash;
    const clicked = page.querySelector(`a.poster[href="${entry.from}"]`);
    entry.anchorTop = clicked ? clicked.getBoundingClientRect().top - viewEl.getBoundingClientRect().top : undefined;
    posterCache[type] = entry;
  };
  return entry.cleanup;
}

async function detailView(container, id) {
  const item = await api('GET', `/api/items/${id}`);
  if (item.type === 'live') {
    start(item);
    location.hash = '#/live';
    return;
  }
  const star = h('button', { class: `btn${item.fav ? ' on' : ''}`, onclick: () => toggleFav(item, starIcon).catch((err) => toast(err.message)) });
  const starIcon = h('span', { class: `icon-btn${item.fav ? ' on' : ''}`, style: 'width:auto;height:auto' }, icon('star', item.fav));
  star.append(starIcon, 'Favoriet');

  const actions = h('div', { class: 'actions' });
  if (item.type === 'movie' || item.type === 'episode') {
    if (item.position) {
      actions.append(h('button', { class: 'btn primary', onclick: () => start(item, { resume: item.position }) }, icon('play', true), `Verder vanaf ${clock(item.position)}`));
      actions.append(h('button', { class: 'btn', onclick: () => start(item) }, 'Vanaf het begin'));
    } else {
      actions.append(h('button', { class: 'btn primary', onclick: () => start(item) }, icon('play', true), 'Afspelen'));
    }
  }
  actions.append(star);
  // Staat dit (of een aflevering van deze serie) in "Verder kijken"? Dan kun je het hier weghalen.
  const tracked = item.type === 'series'
    ? item.episodes?.find((e) => e.position !== undefined)
    : item.position !== undefined && item;
  if (tracked) {
    const remove = h('button', {
      class: 'btn',
      onclick: async () => {
        try {
          await removeFromContinue(tracked);
          remove.replaceWith(h('span', { class: 'muted small removed-note' }, 'Niet meer in Verder kijken'));
          if (TV) tvFocusDefault();
        } catch (err) {
          toast(err.message);
        }
      },
    }, icon('close'), 'Uit Verder kijken');
    actions.append(remove);
  }

  // Andere talen van deze titel: kies je versie. De huidige staat aan.
  const versions = item.versions?.length > 1 && h('div', { class: 'versions-pick' },
    h('span', { class: 'muted small' }, 'Versie'),
    h('div', { class: 'chips' }, item.versions.map((v) => h('button', {
      class: `chip${v.current ? ' active' : ''}`,
      'aria-pressed': String(v.current),
      title: v.group,
      onclick: () => { if (!v.current) location.replace(`#/item/${v.id}`); },
    }, v.language, h('span', { class: 'chip-sub' }, [v.group, v.year].filter(Boolean).join(' · '))))));

  // Groot achtergrondbeeld; bij films de eerste keer even bij de provider opvragen.
  const hero = h('div', { class: 'hero-backdrop' });
  const showBackdrop = (src) => {
    if (!src) return;
    const img = h('img', { src, alt: '', onerror: () => img.remove() });
    img.addEventListener('load', () => hero.classList.add('loaded'));
    hero.replaceChildren(img);
  };
  if (item.backdrop) showBackdrop(item.backdrop);
  else if (item.type === 'movie') api('GET', `/api/items/${item.id}/backdrop`).then((r) => showBackdrop(r.backdrop)).catch(() => {});

  const page = h('div', { class: 'page detail-page' }, hero,
    h('div', { class: 'page-head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Terug', onclick: () => history.back() }, icon('back')),
      h('h1', { class: 'grow ellipsis' }, clean(item.name))),
    h('div', { class: 'detail' },
      h('div', { class: 'art' }, item.logo && h('img', { src: item.logo, alt: '', onerror: (e) => e.target.remove() })),
      h('div', {},
        h('p', { class: 'muted small' }, [clean(item.group), item.year, item.rating && `★ ${item.rating}`].filter(Boolean).join(' · ')),
        item.plot && h('p', { class: 'plot' }, item.plot),
        actions,
        versions)));

  if (item.type === 'series') {
    if (item.episodeError) page.append(h('p', { class: 'error' }, item.episodeError));
    const seasons = [...new Set(item.episodes.map((e) => e.season ?? 1))];
    const list = h('div', { class: 'rows' });
    const showSeason = (season) => {
      list.replaceChildren(...item.episodes.filter((e) => (e.season ?? 1) === season).map((e) => {
        const percent = e.position && e.duration ? (e.position / e.duration) * 100 : 0;
        return h('div', { class: 'row', 'data-id': e.id },
          h('button', { class: 'row-main', onclick: () => start(e, { resume: e.position ?? 0 }) },
            h('div', { class: 'logo-box' }, String(e.episode ?? '')),
            h('div', { class: 'grow' },
              h('div', { class: 'name ellipsis' }, e.name),
              percent > 0 && h('div', { class: 'meter' }, h('i', { style: `width:${percent}%` })))));
      }));
      markPlaying();
    };
    const tabs = h('div', { class: 'seasons' }, seasons.map((season, index) => h('button', {
      class: index === 0 ? 'active' : '',
      onclick: (e) => {
        tabs.querySelector('.active')?.classList.remove('active');
        e.currentTarget.classList.add('active');
        showSeason(season);
      },
    }, `Seizoen ${season}`)));
    if (seasons.length > 1) page.append(tabs);
    page.append(list);
    if (seasons.length) showSeason(seasons[0]);
    else page.append(h('p', { class: 'muted' }, 'Geen afleveringen gevonden.'));
  }
  container.replaceChildren(page);
}


async function guideView(container) {
  const first = await loadLiveFilters();
  if (!first.groups.length) return container.replaceChildren(emptySources());
  const PX = 4; // pixels per minuut
  const box = h('div', { class: 'guide' });
  const filters = h('div', { class: 'filters' });
  let group = liveFilter.group;
  let latest = 0;
  // Dag in de gids: 0 = vandaag, 1 = gisteren, … Terugkijken kan alleen bij zenders met een archief.
  let day = 0;
  const days = h('div', { class: 'chips guide-days' });
  const dayStart = (back) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back); return d.getTime(); };
  const dayLabel = (back) => (back === 0 ? 'Vandaag' : back === 1 ? 'Gisteren' : back === 2 ? 'Eergisteren'
    : new Date(dayStart(back)).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'short' }));
  function drawDays(maxBack) {
    days.replaceChildren(...Array.from({ length: maxBack + 1 }, (_, i) => maxBack - i).map((back) => h('button', {
      type: 'button', class: `chip${back === day ? ' active' : ''}`,
      onclick: () => { day = back; load(); },
    }, dayLabel(back))));
    days.hidden = maxBack === 0;
  }
  drawDays(0);

  /** Een uitzending van eerder afspelen. */
  function playPast(channel, p) {
    const when = new Date(p.start).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    start({ ...channel, type: 'catchup', name: p.title, group: `${clean(channel.name)} · ${when}`, catchup: { start: p.start, stop: p.stop } });
  }

  async function load() {
    const mine = ++latest;
    box.replaceChildren(h('p', { class: 'empty' }, 'Laden…'));
    // Vandaag vanaf 06:00 (dan zie je ook wat er eerder vandaag was); eerdere dagen helemaal.
    const today = day === 0;
    const from = today ? Math.min(dayStart(0) + 6 * 3600000, Math.floor(Date.now() / 1800000) * 1800000 - 1800000) : dayStart(day);
    const span = today ? Math.ceil((Date.now() + 6 * 3600000 - from) / 3600000) : 24;
    const params = new URLSearchParams({ from, hours: span });
    if (liveFilter.country) params.set('country', liveFilter.country);
    if (group) params.set('group', group);
    const data = await api('GET', `/api/guide?${params}`);
    if (mine !== latest) return;
    const width = ((data.to - data.from) / 60000) * PX;
    const x = (ms) => ((ms - data.from) / 60000) * PX;
    const now = Date.now();
    const hours = [];
    for (let t = data.from; t < data.to; t += 1800000) hours.push(h('span', { style: `left:${x(t)}px` }, time(t)));

    const maxBack = Math.min(7, Math.max(0, ...data.channels.map((c) => c.archiveDays ?? 0)));
    drawDays(maxBack);
    const rows = data.channels.map((channel) => h('div', { class: 'guide-row' },
      h('button', { class: 'guide-channel', onclick: () => start(channel) }, logoBox(channel),
        h('span', { class: 'ellipsis' }, clean(channel.name)),
        channel.archiveDays && h('span', { class: 'archive-mark', title: `Terugkijken tot ${channel.archiveDays} dagen` }, icon('replay'))),
      h('div', { class: 'guide-track', style: `width:${width}px` }, channel.programmes.map((p) => {
        const left = Math.max(0, x(p.start));
        const right = Math.min(width, x(p.stop));
        const current = p.start <= now && p.stop > now;
        const past = p.stop <= now;
        const canReplay = (past || current) && channel.archiveDays && p.start >= now - channel.archiveDays * 86400000;
        // Wat nu loopt: live kijken. Wat voorbij is: terugkijken als dat kan.
        const play = current ? () => start(channel) : canReplay ? () => playPast(channel, p) : () => toast(past ? 'Bij deze zender kun je niet terugkijken.' : 'Deze uitzending is nog niet begonnen.');
        return h('button', {
          class: `guide-show${current ? ' current' : ''}${past ? ' past' : ''}${canReplay && past ? ' replay' : ''}`,
          style: `left:${left}px;width:${Math.max(0, right - left - 2)}px`,
          title: canReplay && past ? 'Terugkijken' : undefined,
          onclick: play,
        }, h('b', {}, canReplay && past ? [icon('replay'), ' ', p.title] : p.title), h('span', {}, `${time(p.start)} – ${time(p.stop)}`),
        current && canReplay && h('span', { class: 'replay-start', role: 'button', title: 'Vanaf het begin', onclick: (e) => { e.stopPropagation(); playPast(channel, p); } }, icon('replay'), ' Vanaf begin'));
      }))));

    const inner = h('div', { class: 'guide-inner' },
      h('div', { class: 'guide-times' }, h('div', { class: 'guide-corner' }), h('div', { class: 'guide-scale', style: `width:${width}px` }, hours)),
      rows,
      now >= data.from && now < data.to && h('div', { class: 'guide-now', style: `left:${104 + x(now)}px` }));
    box.replaceChildren(inner);
    // Vandaag bij nu beginnen, eerdere dagen bij de avond (20:00).
    box.scrollLeft = Math.max(0, (today ? x(now) : x(dayStart(day) + 20 * 3600000)) - 60);
  }

  function drawFilters({ countries, groups }) {
    const onCountry = async () => {
      group = '';
      load();
      drawFilters(await loadLiveFilters());
    };
    filters.replaceChildren(...[
      countries.length && countrySelect(countries, onCountry),
      groupSelect(groups, group, (value) => {
        group = value;
        load();
      }),
    ].filter(Boolean));
  }

  drawFilters(first);
  container.replaceChildren(h('div', { class: 'page' }, filters, days, box));
  await load();
}

// ---- Instellingen

function accountPanel() {
  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      try {
        await api('POST', '/api/password', values);
        form.reset();
        toast('Wachtwoord gewijzigd.');
      } catch (err) {
        toast(err.message);
      }
    },
  },
    field('Huidig wachtwoord', { name: 'current', type: 'password', autocomplete: 'current-password', required: true }),
    field('Nieuw wachtwoord (minimaal 8 tekens)', { name: 'next', type: 'password', autocomplete: 'new-password', minLength: 8, required: true }),
    h('button', { class: 'btn', type: 'submit' }, 'Wachtwoord wijzigen'));
  return h('section', { class: 'panel' },
    h('div', { class: 'list-item account-head', style: 'border:0;padding-top:0' },
      h('span', { class: 'nav-avatar account-avatar' }, avatar(state.user, { self: true })),
      h('div', { class: 'grow' }, h('h2', {}, state.user.username), h('span', { class: 'muted small' }, state.user.role === 'admin' ? 'Beheerder' : 'Kijker')),
      h('button', {
        class: 'btn compact',
        onclick: async () => {
          stopPlayback();
          await api('POST', '/api/logout');
          state.user = null;
          renderApp();
        },
      }, 'Uitloggen')),
    TV && h('div', { class: 'theme-picker actions' }, h('button', { class: 'btn', onclick: () => showProfiles() }, 'Wissel van profiel'),
      // Alleen in de tv-app vanaf versie 1.3: ander serveradres instellen.
      window.KijkboxApp && h('button', { class: 'btn', onclick: () => window.KijkboxApp.changeServer() }, 'Serveradres van de app wijzigen')),
    h('details', {}, h('summary', {}, 'Wachtwoord wijzigen'), form));
}

/** Hoe Kijkbox er voor jou uitziet: profielfoto, kleur, licht/donker en een eigen stijl. */
function appearancePanel() {
  const looks = h('div', {});
  const save = async (look) => {
    const previous = state.user.look ?? {};
    state.user.look = look;
    applyLook(look);
    drawLooks();
    try {
      await api('POST', '/api/look', { look });
    } catch (err) {
      state.user.look = previous;
      applyLook(previous);
      drawLooks();
      toast(err.message);
    }
  };
  function drawLooks() {
    const look = state.user.look ?? {};
    const same = (preset) => LOOK_CHOICES.every(([key]) => (preset[key] ?? '') === (look[key] ?? ''));
    looks.replaceChildren(
      h('div', { class: 'theme-picker' }, h('div', { class: 'muted small' }, 'Kant-en-klare stijlen'),
        h('div', { class: 'chips' }, LOOK_PRESETS.map(([label, preset]) => h('button', {
          type: 'button', class: `chip${same(preset) ? ' active' : ''}`, 'aria-pressed': String(same(preset)),
          onclick: () => save({ ...Object.fromEntries(LOOK_CHOICES.map(([key]) => [key, ''])), ...preset }),
        }, label)))),
      ...LOOK_CHOICES.filter(([key]) => key !== 'pattern')
        .map(([key, label, options]) => choiceRow(label, options, look[key] ?? '', (value) => save({ ...look, [key]: value }))),
      patternPicker(look.pattern ?? '', (value) => save({ ...look, pattern: value })));
  }
  drawLooks();

  return h('section', { class: 'panel' },
    h('h2', { style: 'margin-bottom:6px' }, 'Weergave'),
    h('p', { class: 'muted small' }, 'Alleen voor jouw account. Op de tv zie je dezelfde keuzes.'),
    avatarPicker(),
    themePicker(),
    choiceRow('Licht of donker', APPEARANCES, state.user.appearance ?? '', async (value) => {
      const previous = state.user.appearance ?? '';
      state.user.appearance = value;
      applyAppearance(value);
      try {
        await api('POST', '/api/appearance', { appearance: value });
      } catch (err) {
        state.user.appearance = previous;
        applyAppearance(previous);
        toast(err.message);
      }
    }),
    TV && choiceRow('Tekstgrootte op deze tv', TV_SIZES, localStorage.getItem(TV_SIZE_KEY) ?? '1', applyTvSize),
    h('h3', {}, 'Eigen stijl'),
    looks);
}

/** Achtergrondpatroon kiezen met kleine voorbeelden (in jouw kleur). */
function patternPicker(current, onPick) {
  const options = LOOK_CHOICES.find(([key]) => key === 'pattern')[2];
  return h('div', { class: 'theme-picker' }, h('div', { class: 'muted small' }, 'Achtergrondpatroon (volgt je kleur)'),
    h('div', { class: 'pattern-grid' }, options.map(([value, label]) => h('button', {
      type: 'button', class: `pattern-choice${value === current ? ' active' : ''}`, 'aria-pressed': String(value === current),
      onclick: () => onPick(value),
    }, h('span', { class: `swatch-box pat-${value || 'none'}` }), label))));
}

function avatarPicker() {
  const grid = h('div', { class: 'avatar-grid' });
  const draw = () => grid.replaceChildren(...['', ...Object.keys(AVATAR_ART)].map((key) => h('button', {
    type: 'button',
    class: `avatar-choice${(state.user.avatar ?? '') === key ? ' active' : ''}`,
    title: key ? AVATAR_ART[key][0] : 'Eerste letter',
    'aria-label': key ? AVATAR_ART[key][0] : 'Eerste letter van je naam',
    'aria-pressed': String((state.user.avatar ?? '') === key),
    onclick: async () => {
      const previous = state.user.avatar ?? '';
      state.user.avatar = key;
      draw();
      updateNavAvatar();
      try {
        await api('POST', '/api/avatar', { avatar: key });
      } catch (err) {
        state.user.avatar = previous;
        draw();
        updateNavAvatar();
        toast(err.message);
      }
    },
  }, avatar({ ...state.user, avatar: key }, { self: true }))));
  draw();
  return h('div', { class: 'theme-picker' }, h('div', { class: 'muted small' }, 'Profielfoto (de achtergrond is je kleur)'), grid);
}

/** Landen en categorieën verbergen die je nooit kijkt (alleen voor jouw account). */
function hiddenPanel() {
  const countriesBox = h('div', { class: 'checklist' }, h('p', { class: 'muted small' }, 'Laden…'));
  const groupsBox = h('div', { class: 'checklist' });
  const results = h('div', { class: 'checklist' });
  let hiddenGroups = new Set();

  const toggle = async (kind, value, hidden, input) => {
    try {
      await api('POST', '/api/hidden', { kind, value, hidden });
      if (kind === 'group') {
        if (hidden) hiddenGroups.add(value); else hiddenGroups.delete(value);
        drawGroups();
      }
    } catch (err) {
      if (input) input.checked = !hidden;
      toast(err.message);
    }
  };
  const check = (kind, value, label, checked, extra) => {
    const input = h('input', { type: 'checkbox', checked, onchange: (e) => toggle(kind, value, e.target.checked, e.target) });
    return h('label', { class: 'check' }, input, h('span', { class: 'grow' }, label), extra && h('span', { class: 'muted small' }, extra));
  };
  function drawGroups() {
    groupsBox.replaceChildren(...[...hiddenGroups].sort().map((g) => check('group', g, g, true)));
    if (!hiddenGroups.size) groupsBox.append(h('p', { class: 'muted small' }, 'Nog geen categorieën verborgen.'));
  }
  const search = h('input', {
    type: 'search', placeholder: 'Zoek een categorie om te verbergen', 'aria-label': 'Zoek categorie',
    oninput: debounce(async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) return results.replaceChildren();
      const rows = await api('GET', `/api/hidden/groups?q=${encodeURIComponent(q)}`).catch(() => []);
      const kinds = { live: 'zenders', movie: 'films', series: 'series' };
      const seen = new Set();
      results.replaceChildren(...rows.filter((r) => !seen.has(r.name) && seen.add(r.name))
        .map((r) => check('group', r.name, r.name, hiddenGroups.has(r.name), `${r.count} ${kinds[r.type] ?? ''}`)));
      if (!rows.length) results.append(h('p', { class: 'muted small' }, 'Geen categorie gevonden.'));
    }, 300),
  });

  api('GET', '/api/hidden').then((data) => {
    const hiddenCountries = new Set(data.hiddenCountries);
    hiddenGroups = new Set(data.hiddenGroups);
    countriesBox.replaceChildren(...data.countries.map((c) => check('country', c.code, c.label, hiddenCountries.has(c.code), String(c.count))));
    drawGroups();
  }).catch((err) => countriesBox.replaceChildren(h('p', { class: 'error small' }, err.message)));

  return h('section', { class: 'panel' },
    h('h2', {}, 'Verbergen'),
    h('p', { class: 'muted small' }, 'Wat je hier aanvinkt, zie je niet meer bij Live, Gids, Films en Series. Alleen voor jouw account.'),
    h('details', {}, h('summary', {}, 'Landen'), countriesBox),
    h('details', {}, h('summary', {}, 'Categorieën'), search, results, h('div', { class: 'muted small', style: 'margin-top:10px' }, 'Verborgen:'), groupsBox));
}

function themePicker() {
  const custom = h('input', {
    type: 'color', class: 'color-input', 'aria-label': 'Eigen kleur kiezen', title: 'Eigen kleur',
    value: isCustomColor(state.user.theme) ? state.user.theme : '#22c55e',
  });
  const customWrap = h('label', { class: 'swatch custom', title: 'Eigen kleur' }, custom);
  async function pick(key) {
    const previous = state.user.theme ?? '';
    state.user.theme = key;
    applyTheme(key);
    mark();
    try {
      await api('POST', '/api/theme', { theme: key });
    } catch (err) {
      state.user.theme = previous;
      applyTheme(previous);
      mark();
      toast(err.message);
    }
  }
  const buttons = THEMES.map(([key, label, color]) => h('button', {
    type: 'button', class: 'swatch', style: `--swatch:${color}`, title: label, 'aria-label': `Kleur ${label}`,
    onclick: () => pick(key),
  }));
  function mark() {
    const current = state.user.theme ?? '';
    THEMES.forEach(([key], i) => {
      buttons[i].classList.toggle('active', key === current);
      buttons[i].setAttribute('aria-pressed', String(key === current));
    });
    customWrap.classList.toggle('active', isCustomColor(current));
    customWrap.style.setProperty('--swatch', isCustomColor(current) ? current : '');
  }
  // Tijdens het slepen alleen laten zien, bij loslaten opslaan.
  custom.addEventListener('input', () => applyTheme(custom.value));
  custom.addEventListener('change', () => pick(custom.value.toLowerCase()));
  mark();
  return h('div', { class: 'theme-picker' }, h('div', { class: 'muted small' }, 'Kleur'), h('div', { class: 'swatches' }, buttons, customWrap));
}

function sourceForm(onAdded) {
  const TYPES = { xtream: 'Xtream', m3u: 'M3U-link', m3u_text: 'M3U-bestand', single: 'Losse stream' };
  let type = 'xtream';
  const fields = h('div', { class: 'form' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });

  function drawFields() {
    tabs.replaceChildren(...Object.entries(TYPES).map(([key, label]) => h('button', {
      type: 'button', class: key === type ? 'active' : '',
      onclick: () => { type = key; drawFields(); },
    }, label)));
    const url = { name: 'url', type: 'url', inputMode: 'url', autocapitalize: 'none', autocomplete: 'off', required: true };
    const list = [field('Naam', { name: 'name', required: true, maxLength: 100, placeholder: type === 'single' ? 'Bijvoorbeeld NPO 1' : 'Bijvoorbeeld Mijn provider' })];
    if (type === 'xtream') {
      list.push(
        field('Server-adres', { ...url, placeholder: 'http://server.voorbeeld:8080' }),
        field('Gebruikersnaam', { name: 'username', autocapitalize: 'none', autocomplete: 'off', required: true }),
        field('Wachtwoord', { name: 'password', type: 'password', autocomplete: 'off', required: true }),
        h('label', {}, 'Streamformaat', h('select', { name: 'streamFormat' },
          h('option', { value: 'ts' }, 'MPEG-TS (aanbevolen)'),
          h('option', { value: 'hls' }, 'HLS'))),
      );
    } else if (type === 'm3u') {
      list.push(field('Link naar de afspeellijst', { ...url, placeholder: 'https://…/playlist.m3u' }));
    } else if (type === 'single') {
      list.push(field('Link naar de stream', { ...url, placeholder: 'https://…/stream.m3u8' }));
    } else {
      const area = h('textarea', { name: 'content', required: true, placeholder: '#EXTM3U …' });
      list.push(
        field('Bestand kiezen', {
          type: 'file', accept: '.m3u,.m3u8,.txt',
          onchange: async (e) => {
            if (e.target.files[0]) area.value = await e.target.files[0].text();
          },
        }),
        h('label', {}, 'Of plak de inhoud hier', area),
      );
    }
    if (type !== 'single') {
      list.push(h('details', {}, h('summary', {}, 'Meer opties'), h('div', { class: 'form', style: 'margin-top:12px' },
        field('Tv-gids (XMLTV-link, optioneel)', { name: 'epgUrl', type: 'url', autocapitalize: 'none' }),
        field('User-agent (optioneel)', { name: 'userAgent', autocapitalize: 'none' }))));
    }
    fields.replaceChildren(...list);
  }
  drawFields();

  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Bron toevoegen');
  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      const values = Object.fromEntries(new FormData(form));
      delete values[''];
      try {
        await api('POST', '/api/sources', { ...values, type });
        form.reset();
        drawFields();
        toast('Bron toegevoegd. De lijst wordt nu opgehaald.');
        onAdded();
      } catch (err) {
        toast(err.message);
      } finally {
        submit.disabled = false;
      }
    },
  }, tabs, fields, submit);
  return form;
}

function sourcesPanel() {
  const list = h('div', {});
  let timer;

  async function refresh() {
    clearTimeout(timer);
    if (!list.isConnected && timer) return;
    let sources;
    try {
      sources = await api('GET', '/api/sources');
    } catch (err) {
      toast(err.message);
      return;
    }
    list.replaceChildren(...sources.map(sourceRow));
    if (!sources.length) list.append(h('p', { class: 'muted' }, 'Nog geen bronnen. Voeg hieronder je eerste bron toe.'));
    if (sources.some((s) => s.status === 'bezig')) timer = setTimeout(refresh, 1500);
  }

  function sourceRow(source) {
    const parts = [];
    if (source.counts.live) parts.push(`${source.counts.live} zenders`);
    if (source.counts.movie) parts.push(`${source.counts.movie} films`);
    if (source.counts.series) parts.push(`${source.counts.series} series`);
    const account = source.account;
    return h('div', { class: 'list-item' },
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, source.name), ' ', h('span', { class: `pill ${source.status}` }, source.status)),
        h('div', { class: 'muted small' }, parts.join(' · ') || 'Nog leeg'),
        source.error && h('div', { class: 'error small' }, source.error),
        source.epgStatus && h('div', { class: 'muted small' }, `Tv-gids: ${source.epgStatus}`),
        source.nextRefresh && h('div', { class: 'muted small' }, `${source.lastRefresh ? `Bijgewerkt ${dateTime(source.lastRefresh)} · ` : ''}volgende update ${dateTime(source.nextRefresh)}`),
        account?.expires && h('div', { class: 'muted small' }, `Abonnement tot ${dateTime(account.expires)}${account.maxConnections ? ` · max. ${account.maxConnections} tegelijk` : ''}`)),
      h('button', {
        class: 'icon-btn', 'aria-label': `${source.name} verversen`,
        onclick: async () => { await api('POST', `/api/sources/${source.id}/refresh`); refresh(); },
      }, icon('refresh')),
      h('button', {
        class: 'icon-btn', 'aria-label': `${source.name} verwijderen`,
        onclick: async () => {
          if (!confirm(`Bron "${source.name}" verwijderen? Bijbehorende favorieten verdwijnen ook.`)) return;
          await api('DELETE', `/api/sources/${source.id}`);
          refresh();
        },
      }, icon('trash')));
  }

  refresh();
  return h('section', { class: 'panel' }, h('h2', {}, 'Bronnen'), list,
    h('h2', { style: 'margin:18px 0 12px' }, 'Bron toevoegen'), sourceForm(refresh));
}

function usersPanel() {
  const list = h('div', {});
  const notice = h('div', {});

  /** Het tijdelijke wachtwoord één keer laten zien, om door te geven. */
  function showTemp(username, password) {
    const code = h('code', {}, password);
    const copy = h('button', {
      class: 'btn compact', type: 'button',
      onclick: () => {
        // Werkt ook zonder https: de tekst selecteren en de browser laten kopiëren.
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        toast(document.execCommand('copy') ? 'Gekopieerd.' : 'Geselecteerd: kopieer het met Ctrl+C.');
      },
    }, 'Kopiëren');
    notice.replaceChildren(h('div', { class: 'temp-password' },
      h('div', { class: 'grow' },
        h('div', {}, `Tijdelijk wachtwoord voor ${username}:`),
        code,
        h('div', { class: 'muted small' }, 'Geef dit door. Bij de eerste keer inloggen kiest de gebruiker zelf een nieuw wachtwoord. Je ziet het hier maar één keer.')),
      copy,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Sluiten', onclick: () => notice.replaceChildren() }, icon('close'))));
  }

  async function refresh() {
    const users = await api('GET', '/api/users');
    list.replaceChildren(...users.map((user) => h('div', { class: 'list-item' },
      avatar(user),
      h('div', { class: 'grow' },
        h('b', {}, user.username), user.id === state.user.id && h('span', { class: 'muted small' }, ' (jij)'),
        user.temporary && h('div', { class: 'muted small' }, 'Heeft nog een tijdelijk wachtwoord')),
      h('select', {
        'aria-label': `Rol van ${user.username}`, style: 'width:auto;min-height:36px;padding:4px 8px',
        onchange: async (e) => {
          try {
            await api('PATCH', `/api/users/${user.id}`, { role: e.target.value });
            toast('Rol aangepast.');
          } catch (err) {
            toast(err.message);
            refresh();
          }
        },
      }, h('option', { value: 'viewer', selected: user.role === 'viewer' }, 'Kijker'), h('option', { value: 'admin', selected: user.role === 'admin' }, 'Beheerder')),
      user.id !== state.user.id && h('button', {
        class: 'btn compact',
        onclick: async () => {
          if (!confirm(`Nieuw tijdelijk wachtwoord voor ${user.username}? Het oude werkt dan niet meer en ${user.username} wordt overal uitgelogd.`)) return;
          try {
            const { tempPassword } = await api('PATCH', `/api/users/${user.id}`, { resetPassword: true });
            showTemp(user.username, tempPassword);
            refresh();
          } catch (err) {
            toast(err.message);
          }
        },
      }, 'Wachtwoord vergeten'),
      user.id !== state.user.id && h('button', {
        class: 'icon-btn', 'aria-label': `${user.username} verwijderen`,
        onclick: async () => {
          if (!confirm(`Account "${user.username}" verwijderen?`)) return;
          await api('DELETE', `/api/users/${user.id}`);
          refresh();
        },
      }, icon('trash')))));
  }
  refresh().catch((err) => toast(err.message));

  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      try {
        const { tempPassword } = await api('POST', '/api/users', values);
        form.reset();
        showTemp(values.username, tempPassword);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
  },
    field('Gebruikersnaam', { name: 'username', autocapitalize: 'none', autocomplete: 'off', required: true }),
    h('label', {}, 'Rol', h('select', { name: 'role' }, h('option', { value: 'viewer' }, 'Kijker'), h('option', { value: 'admin' }, 'Beheerder'))),
    h('p', { class: 'muted small' }, 'Kijkbox maakt een tijdelijk wachtwoord. Daarmee logt de nieuwe gebruiker de eerste keer in en kiest dan zelf een wachtwoord.'),
    h('button', { class: 'btn', type: 'submit' }, 'Account aanmaken'));

  return h('section', { class: 'panel' }, h('h2', {}, 'Accounts'), notice, list, h('details', { style: 'margin-top:12px' }, h('summary', {}, 'Nieuw account'), form));
}

// Onderdelen van Instellingen. De laatste vier zijn alleen voor beheerders.
const SETTINGS_TABS = [
  ['', 'Account', false, () => [accountPanel(), !TV && pairPanel()]],
  ['weergave', 'Weergave', false, () => [appearancePanel()]],
  ['verbergen', 'Verbergen', false, () => [hiddenPanel()]],
  ['status', 'Status', true, () => [statusPanel()], () => !TV],
  ['bronnen', 'Bronnen', true, () => [sourcesPanel()]],
  ['gebruikers', 'Gebruikers', true, () => [usersPanel()]],
  ['server', 'Server', true, () => [updatesPanel(), backupsPanel(), networkPanel(), subtitlesPanel()], () => !TV],
];

function settingsView(container, tab = '') {
  const admin = state.user.role === 'admin';
  const tabs = SETTINGS_TABS.filter(([, , adminOnly, , show]) => (!adminOnly || admin) && (!show || show()));
  const current = tabs.find(([key]) => key === tab) ?? tabs[0];
  const link = ([key, label]) => h('a', {
    class: `chip${key === current[0] ? ' active' : ''}`,
    href: key ? `#/instellingen/${key}` : '#/instellingen',
    'aria-current': key === current[0] ? 'page' : undefined,
  }, label);
  const mine = tabs.filter(([, , adminOnly]) => !adminOnly);
  const manage = tabs.filter(([, , adminOnly]) => adminOnly);
  const nav = h('nav', { class: 'settings-tabs', 'aria-label': 'Onderdelen' },
    mine.map(link),
    manage.length ? h('span', { class: 'settings-sep muted small' }, 'Beheer') : null,
    manage.map(link));
  const page = h('div', { class: 'page settings' }, h('div', { class: 'page-head' }, h('h1', {}, 'Instellingen')), nav, ...current[3]().filter(Boolean));
  container.replaceChildren(page);
}

/** Beheerder: wie kijkt er nu wat, hoe druk is de server en hoeveel verbindingen telt de provider. */
function statusPanel() {
  const body = h('div', {}, h('p', { class: 'muted small' }, 'Laden…'));
  const gb = (bytes) => `${(bytes / 1073741824).toFixed(1).replace('.', ',')} GB`;
  const since = (ms) => {
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} u ${min % 60} min`;
  };
  const uptime = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${Math.round(sec / 3600)} uur` : `${Math.round(sec / 86400)} dagen`);
  const modes = { live: 'live', remux: 'doorgegeven via ffmpeg', transcode: 'omgezet (zwaar voor de server)', direct: 'rechtstreeks doorgegeven' };
  const row = (label, value) => h('div', { class: 'status-row' }, h('span', { class: 'muted' }, label), h('span', {}, value));

  let timer = null;
  async function load() {
    clearTimeout(timer);
    // Alleen verversen zolang het paneel op het scherm staat.
    if (!document.body.contains(section) && timer) return;
    let data;
    try {
      data = await api('GET', '/api/status');
    } catch (err) {
      body.replaceChildren(h('p', { class: 'error small' }, err.message));
      timer = setTimeout(load, 10000);
      return;
    }
    const watching = data.playing.length
      ? data.playing.map((p) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' },
          h('div', {}, clean(p.name)),
          h('div', { class: 'muted small' }, [
            p.watchers.map((w) => `${w.user} (${w.device})`).join(', ') || 'onbekend wie',
            modes[p.mode] ?? p.mode,
            `sinds ${since(p.since)}`,
          ].join(' · ')),
          p.failed ? h('div', { class: 'error small' }, p.failed) : null),
        p.provider ? h('span', { class: 'badge' }, 'verbinding') : null))
      : [h('p', { class: 'muted small' }, 'Er kijkt nu niemand.')];

    const providers = data.providers.map((p) => (p.error
      ? row(p.name, p.error)
      : row(p.name, [
        p.max ? `${p.active} van ${p.max} verbinding${p.max === 1 ? '' : 'en'} in gebruik` : `${p.active} in gebruik`,
        p.expires ? `loopt tot ${new Date(p.expires).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}` : null,
      ].filter(Boolean).join(' · '))));

    const sys = data.system;
    const used = sys.memTotal - sys.memFree;
    body.replaceChildren(...[
      h('h3', {}, 'Nu aan het kijken'), ...watching,
      providers.length ? h('h3', {}, 'Provider') : null, ...providers,
      providers.length ? h('p', { class: 'muted small' }, 'De provider telt ook verbindingen van andere apparaten of servers met hetzelfde account.') : null,
      h('h3', {}, 'Server'),
      row('Processor', sys.cpu === null ? 'meten…' : `${sys.cpu}% (${sys.cores} kernen)`),
      row('Geheugen', `${gb(used)} van ${gb(sys.memTotal)} in gebruik, waarvan Kijkbox ${gb(sys.memKijkbox)}`),
      sys.disk ? row('Opslag', `${gb(sys.disk.free)} vrij van ${gb(sys.disk.total)}`) : null,
      row('Versie', `${data.version} · draait ${uptime(data.uptime)}`),
    ].filter(Boolean));
    timer = setTimeout(load, 5000);
  }

  const section = h('section', { class: 'panel' },
    h('h2', { style: 'margin-bottom:6px' }, 'Status'),
    body);
  load();
  return section;
}

/** Beheerder: back-ups maken, downloaden en terugzetten. */
function backupsPanel() {
  const list = h('div', {}, h('p', { class: 'muted small' }, 'Laden…'));
  const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} kB`;
  const reasons = { dagelijks: 'automatisch', handmatig: 'met de hand', 'voor-terugzetten': 'vóór terugzetten' };

  async function restore(payload, label) {
    if (!window.confirm(`${label} terugzetten?\n\nAccounts, bronnen, favorieten, verder kijken en instellingen worden vervangen door die uit de back-up. Er wordt eerst nog een back-up van de huidige stand gemaakt.`)) return;
    try {
      const r = await api('POST', '/api/backups/restore', payload);
      window.alert(`Teruggezet: ${r.users} accounts, ${r.sources} bronnen, ${r.favorites} favorieten en ${r.progress} keer verder kijken.`
        + (r.waiting ? `\n\n${r.waiting} favorieten of voortgang volgen vanzelf zodra de bronnen opnieuw zijn ingelezen.` : ''));
      location.reload();
    } catch (err) {
      toast(err.message);
    }
  }

  async function load() {
    let rows;
    try {
      rows = await api('GET', '/api/backups');
    } catch (err) {
      list.replaceChildren(h('p', { class: 'error small' }, err.message));
      return;
    }
    list.replaceChildren(...rows.map((b) => {
      const reason = Object.entries(reasons).find(([key]) => b.name.includes(key))?.[1] ?? '';
      return h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, h('div', {}, dateTime(b.at)), h('div', { class: 'muted small' }, [reason, kb(b.size)].filter(Boolean).join(' · '))),
        h('a', { class: 'btn compact', href: `/api/backups/${encodeURIComponent(b.name)}`, download: b.name }, 'Downloaden'),
        h('button', { class: 'btn compact', onclick: () => restore({ name: b.name }, `De back-up van ${dateTime(b.at)}`) }, 'Terugzetten'));
    }));
    if (!rows.length) list.append(h('p', { class: 'muted small' }, 'Nog geen back-ups. De eerste wordt vannacht gemaakt, of druk op "Nu back-up maken".'));
  }

  const upload = h('input', {
    type: 'file', accept: '.json,application/json',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        return toast('Dit bestand is geen Kijkbox-back-up.');
      }
      restore({ data }, `"${file.name}"`);
    },
  });

  load();
  return h('section', { class: 'panel' },
    h('h2', { style: 'margin-bottom:6px' }, 'Back-ups'),
    h('p', { class: 'muted small' }, 'Elke nacht om 03:00 maakt Kijkbox een back-up van accounts, bronnen, favorieten, verder kijken en instellingen; de 10 nieuwste blijven bewaard. De zender- en filmlijsten zitten er niet in, die haalt Kijkbox gewoon opnieuw bij je provider. Let op: een back-up bevat de wachtwoorden van je provider. Bewaar een download dus veilig.'),
    list,
    h('div', { class: 'actions', style: 'margin-top:12px' },
      h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/backups'); toast('Back-up gemaakt.'); load(); } catch (err) { toast(err.message); } } }, 'Nu back-up maken'),
      h('label', { class: 'btn' }, 'Back-up van een andere server terugzetten…', upload)));
}

/** Beheerder: alleen thuisnetwerk, of ook van buitenaf via een reverse proxy. */
function networkPanel() {
  const status = h('p', { class: 'muted small' }, 'Laden…');
  const input = h('input', { name: 'proxy', placeholder: 'Bijvoorbeeld 192.168.1.5', autocomplete: 'off', inputmode: 'decimal' });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Opslaan');
  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      try {
        show(await api('POST', '/api/network', { proxy: input.value.trim() }));
        toast(input.value.trim() ? 'Reverse proxy ingesteld.' : 'Alleen nog bereikbaar op het thuisnetwerk.');
      } catch (err) {
        toast(err.message);
      }
    },
  }, h('label', {}, 'IP-adres van je reverse proxy (leeg = alleen thuisnetwerk)', input), save);

  function show(s) {
    input.value = s.proxy ?? '';
    input.disabled = save.disabled = s.fromEnv;
    status.textContent = [
      s.allowPublic ? 'Bereikbaar vanaf elk adres (ALLOW_PUBLIC staat aan).'
        : s.proxy ? `Thuisnetwerk, en van buitenaf via de reverse proxy op ${s.proxy}.`
          : 'Alleen bereikbaar op het thuisnetwerk.',
      s.fromEnv && 'Dit adres staat vast in de serverinstellingen (TRUST_PROXY).',
    ].filter(Boolean).join(' ');
  }
  api('GET', '/api/network').then(show).catch((err) => { status.textContent = err.message; });
  return h('section', { class: 'panel' },
    h('h2', { style: 'margin-bottom:6px' }, 'Netwerk'),
    status,
    h('p', { class: 'muted small' }, 'Wil je Kijkbox ook buiten huis gebruiken, zet hem dan achter een reverse proxy met https (bijvoorbeeld Nginx Proxy Manager of Caddy) en vul hier het IP-adres van die proxy in. Andere adressen van buitenaf blijven geweigerd.'),
    form);
}

/** Beheerder: versie, nieuwe versies en installeren (via kijkbox-update op de server). */
function updatesPanel() {
  const body = h('div', { class: 'form' }, h('p', { class: 'muted small' }, 'Laden…'));
  let timer = null;

  async function act(payload) {
    try {
      show(await api('POST', '/api/update', payload));
    } catch (err) {
      toast(err.message);
    }
  }

  function show(s) {
    clearTimeout(timer);
    if (!body.isConnected && timer) return;
    const newer = s.latest && s.latest !== s.version;
    const states = { waiting: 'Wacht tot niemand kijkt, dan wordt de update geïnstalleerd…', installing: 'Bezig met installeren…', checking: 'Bezig met controleren…', error: `Fout: ${s.message}` };
    // replaceChildren zou false/null als tekst tonen; die eruit filteren.
    const parts = (...items) => items.filter((item) => item !== false && item !== null && item !== undefined && item !== '');
    body.replaceChildren(...parts(
      h('p', {}, h('b', {}, `Versie ${s.version}`), s.latest && !newer ? h('span', { class: 'muted small' }, ' · dit is de nieuwste') : null),
      !s.managed && h('p', { class: 'muted small' }, 'Deze installatie is niet met het installatiescript gemaakt; updates gaan hier met de hand.'),
      s.managed && newer && h('div', { class: 'update-new' },
        h('p', {}, h('b', {}, `Nieuwe versie: ${s.latest}`)),
        s.notes && h('pre', { class: 'update-notes' }, s.notes)),
      !newer && s.whatsNew?.notes && h('details', {},
        h('summary', {}, `Wat is er nieuw in versie ${s.whatsNew.version}`),
        h('pre', { class: 'update-notes' }, s.whatsNew.notes)),
      s.managed && (states[s.state] || s.pending) && h('p', { class: s.state === 'error' ? 'error small' : 'muted small' }, states[s.state] ?? 'Verzoek verstuurd…'),
      s.managed && h('div', { class: 'actions' },
        newer && h('button', { class: 'btn primary', disabled: s.pending || s.state === 'waiting' || s.state === 'installing', onclick: () => act({ action: 'install' }) }, 'Update installeren'),
        h('button', { class: 'btn', disabled: s.pending, onclick: () => act({ action: 'check' }) }, 'Nu controleren')),
      s.managed && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: s.auto, onchange: (e) => act({ auto: e.target.checked }) }),
        h('span', { class: 'grow' }, "Automatisch installeren ('s nachts, als niemand kijkt)")),
      s.checkedAt && h('p', { class: 'muted small' }, `Laatst gecontroleerd: ${dateTime(s.checkedAt)}`)));
    // Zolang er iets loopt, de status bijwerken.
    if (s.pending || ['waiting', 'installing', 'checking'].includes(s.state)) timer = setTimeout(load, 3000);
  }
  const load = () => api('GET', '/api/update').then(show).catch((err) => body.replaceChildren(h('p', { class: 'error small' }, err.message)));
  load();
  return h('section', { class: 'panel' }, h('h2', { style: 'margin-bottom:6px' }, 'Updates'), body);
}

/** Beheerder: koppeling met OpenSubtitles. Sleutel en wachtwoord gaan nooit terug naar de browser. */
function subtitlesPanel() {
  const status = h('p', { class: 'muted small' }, 'Laden…');
  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      status.textContent = 'Controleren bij OpenSubtitles…';
      try {
        const saved = await api('POST', '/api/subtitle-settings', values);
        form.reset();
        show(saved);
        state.subtitles = true;
        updateCcButtons();
        toast('Ondertitels zijn ingesteld.');
      } catch (err) {
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    },
  },
    field('API-sleutel', { name: 'apiKey', autocomplete: 'off', spellcheck: false }),
    field('Gebruikersnaam bij OpenSubtitles (aanbevolen: meer downloads per dag)', { name: 'username', autocomplete: 'off' }),
    field('Wachtwoord bij OpenSubtitles', { name: 'password', type: 'password', autocomplete: 'new-password' }),
    h('button', { class: 'btn', type: 'submit' }, 'Opslaan en controleren'));

  function show(s) {
    // De gebruikersnaam staat er al in; leeg maken en opslaan haalt het account weg.
    form.elements.username.defaultValue = form.elements.username.value = s.username ?? '';
    if (!s.configured) {
      status.textContent = 'Nog niet ingesteld. Maak een gratis account op opensubtitles.com en vraag daar een API-sleutel aan (bij "API consumers").';
      return;
    }
    status.textContent = [
      'Ingesteld',
      s.username ? `ingelogd als ${s.username}` : 'zonder account',
      s.remaining != null && `nog ${s.remaining} downloads vandaag`,
    ].filter(Boolean).join(' · ') + '. Een leeg sleutel- of wachtwoordveld laat de opgeslagen waarde staan.';
  }
  api('GET', '/api/subtitle-settings').then(show).catch((err) => { status.textContent = err.message; });
  return h('section', { class: 'panel' }, h('h2', { style: 'margin-bottom:6px' }, 'Ondertitels (OpenSubtitles)'), status, form);
}

// ---- Router en opbouw

const NAV = [
  ['#/home', 'home', 'Home'],
  ['#/live', 'tv', 'Live'],
  ['#/gids', 'guide', 'Gids'],
  ['#/films', 'film', 'Films'],
  ['#/series', 'series', 'Series'],
];

let viewEl;
let cleanup = null;
let routeToken = 0;
let lastRoute = '';

/** Grijze blokken in de vorm van de pagina die eraan komt, in plaats van "Laden…". */
function skeleton(hash) {
  const n = (count, make) => Array.from({ length: count }, make);
  const bar = (cls = '') => h('div', { class: `sk ${cls}` });
  const posters = () => h('div', { class: 'posters' }, n(18, () => h('div', { class: 'sk-poster' }, bar('sk-art'), bar('sk-line'))));
  let body;
  if (hash === '#/films' || hash === '#/series') body = [h('div', { class: 'filters' }, bar('sk-input'), bar('sk-input'), bar('sk-input')), posters()];
  else if (hash === '#/live' || hash === '#/gids') body = [h('div', { class: 'filters' }, bar('sk-input'), bar('sk-input')), n(10, () => h('div', { class: 'sk-row' }, bar('sk-logo'), h('div', { class: 'grow' }, bar('sk-line'), bar('sk-line short'))))];
  else if (hash.startsWith('#/item/')) body = [bar('sk-title'), h('div', { class: 'detail' }, bar('sk-art'), h('div', {}, bar('sk-line'), bar('sk-line'), bar('sk-line short')))];
  else if (hash === '#/home') body = [bar('sk-hero'), bar('sk-title'), h('div', { class: 'shelf-row' }, n(8, () => h('div', { class: 'sk-poster' }, bar('sk-art'))))];
  else return h('div', { class: 'page muted' }, 'Laden…');
  return h('div', { class: 'page skeleton', 'aria-busy': 'true', 'aria-label': 'Laden' }, body);
}

async function route() {
  if (!state.user) return;
  // Mijn lijst is opgegaan in Home; oude bladwijzers komen daar ook uit.
  const hash = !location.hash || location.hash === '#/lijst' ? '#/home' : location.hash;
  const mine = ++routeToken;
  // Terug van een film of serie? Dan mag Films/Series verder waar je was.
  const returning = lastRoute.startsWith('#/item/');
  lastRoute = hash;
  cleanup?.();
  cleanup = null;
  for (const link of document.querySelectorAll('.nav a')) {
    const href = link.getAttribute('href');
    link.classList.toggle('active', !link.classList.contains('nav-profile') && (href === hash || hash.startsWith(`${href}/`)));
  }
  const holder = h('div', {}, skeleton(hash));
  viewEl.replaceChildren(holder);
  viewEl.scrollTop = 0;
  try {
    let stop;
    if (hash === '#/home') stop = await homeView(holder);
    else if (hash === '#/live') stop = await liveView(holder);
    else if (hash === '#/gids') stop = await guideView(holder);
    else if (hash === '#/films') stop = await posterView(holder, 'movie', { returning });
    else if (hash === '#/series') stop = await posterView(holder, 'series', { returning });
    else if (hash === '#/instellingen' || hash.startsWith('#/instellingen/')) stop = settingsView(holder, hash.slice(15));
    else if (hash.startsWith('#/item/')) stop = await detailView(holder, Number(hash.slice(7)));
    else location.hash = '#/home';
    if (mine === routeToken && typeof stop === 'function') cleanup = stop;
    else if (typeof stop === 'function') stop();
    if (TV && mine === routeToken && !stage.classList.contains('active')) tvFocusDefault();
  } catch (err) {
    if (mine === routeToken) holder.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'error' }, err.message)));
  }
}

// ---- Tv: bediening met de afstandsbediening

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]), select, textarea, [tabindex="0"]';
const BACK_KEYS = new Set(['Escape', 'Backspace', 'BrowserBack', 'GoBack', 'Back']);
let tvBarTimer = null;

const isShown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

function tvFocus(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Lijsten laden na het openen van een pagina. Tot dan staat de selectie tijdelijk op iets anders.
let tvWaitingFor = null;

function tvFocusDefault() {
  const scope = document.querySelector('.view') ?? document;
  for (const selector of ['.profile-tile', '.row.playing .row-main', '.live-tile.playing', '.actions .btn.primary', '.row .row-main', '.live-tile', '.poster', '.tile', '.guide-channel']) {
    const found = scope.querySelector(selector);
    if (found && isShown(found)) {
      tvWaitingFor = null;
      return tvFocus(found);
    }
  }
  tvWaitingFor = [...scope.querySelectorAll(FOCUSABLE)].find(isShown) ?? null;
  return tvFocus(tvWaitingFor);
}

/** Na het laden van een lijst: verplaats de selectie, tenzij je intussen zelf iets anders koos. */
function tvListLoaded() {
  if (!TV || stage.classList.contains('active')) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === tvWaitingFor) tvFocusDefault();
}

/** Zoekt het dichtstbijzijnde element in de richting van de pijl. */
function tvMove(direction) {
  const current = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  if (!current || !isShown(current)) return tvFocusDefault();
  // In het menu gaan omhoog/omlaag gewoon naar het vorige/volgende menu-item. Anders wint vanaf
  // Series een poster rechtsonder het van Account, dat helemaal onderaan staat.
  const nav = current.closest('.nav');
  if (nav && (direction === 'up' || direction === 'down')) {
    const items = [...nav.querySelectorAll(FOCUSABLE)].filter(isShown);
    const next = items[items.indexOf(current) + (direction === 'down' ? 1 : -1)];
    if (next) tvFocus(next);
    return;
  }
  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    if (el === current || !isShown(el) || el.closest('.stage')) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const gapX = Math.max(0, Math.max(r.left, from.left) - Math.min(r.right, from.right));
    const gapY = Math.max(0, Math.max(r.top, from.top) - Math.min(r.bottom, from.bottom));
    let main;
    let cross;
    if (direction === 'right' && x > cx + 1) [main, cross] = [Math.max(0, r.left - from.right), gapY];
    else if (direction === 'left' && x < cx - 1) [main, cross] = [Math.max(0, from.left - r.right), gapY];
    else if (direction === 'down' && y > cy + 1) [main, cross] = [Math.max(0, r.top - from.bottom), gapX];
    else if (direction === 'up' && y < cy - 1) [main, cross] = [Math.max(0, from.top - r.bottom), gapX];
    else continue;
    const align = direction === 'up' || direction === 'down' ? Math.abs(x - cx) : Math.abs(y - cy);
    const score = main + cross * 4 + align * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  // Vanuit een pagina naar het menu: kom uit op de pagina waar je bent.
  if (best?.closest('.nav') && !current.closest('.nav')) best = document.querySelector('.nav a.active') ?? best;
  tvFocus(best);
}

let tvNext = null; // de volgende aflevering, als die er is
let tvNextShown = false;

const tvControlList = () => [tvBack10, tvPlay, tvFwd10, tvCc, tvNextEp].filter((b) => !b.hidden);
const tvBarOpen = () => stage.classList.contains('show-bar');
const tvInControls = () => tvControls.contains(document.activeElement);

function tvHideBar() {
  stage.classList.remove('show-bar');
  if (stage.contains(document.activeElement)) document.activeElement.blur();
}

/** Toont de balk. Bij pauze of vlak voor het einde blijft hij staan. */
function tvShowBar(focus) {
  stage.classList.add('show-bar');
  clearTimeout(tvBarTimer);
  tvUpdateTime();
  if (!video.paused && !tvNextShown) tvBarTimer = setTimeout(tvHideBar, 5000);
  if (player.item?.type === 'live') return;
  if (focus) focus.focus({ preventScroll: true });
  else if (!tvInControls()) tvPlay.focus({ preventScroll: true });
}

function tvTogglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

/** Het einde is pas bekend als de hele aflevering binnen is; bij omzetten groeit de duur nog. */
function tvKnownEnd() {
  if (!player.hls) return Number.isFinite(video.duration);
  const levels = player.hls.levels ?? [];
  const details = levels[Math.max(0, player.hls.currentLevel)]?.details;
  return details ? details.live === false : false;
}

function tvNearEnd() {
  return Boolean(tvNext) && tvKnownEnd() && video.duration - video.currentTime <= 30;
}

function tvCheckNext() {
  const near = tvNearEnd();
  if (near && !tvNextShown) {
    tvNextShown = true;
    tvShowBar(tvNextEp);
  } else if (!near && tvNextShown) {
    tvNextShown = false;
    tvUpdateTime();
  }
}

function tvPlayNext() {
  const next = tvNext;
  if (!next) return;
  // De huidige aflevering is hiermee uitgekeken. Niet meer opslaan, anders komt hij terug in Verder kijken.
  player.started = false;
  api('POST', `/api/progress/${player.item.id}`, { finished: true }).catch(() => {});
  // Verder kijken waar je was, behalve als je die aflevering al (bijna) uit had.
  const halfway = next.position && next.duration && next.position < next.duration * 0.9;
  start(next, { resume: halfway ? next.position : 0 });
}

/** Zoekt bij een aflevering de volgende op, voor de knop aan het einde. */
function tvLoadNext(item) {
  tvNext = null;
  tvNextShown = false;
  if (!TV || item.type !== 'episode' || !item.parentId) return;
  api('GET', `/api/items/${item.parentId}`).then(({ episodes = [] }) => {
    if (player.item?.id !== item.id) return;
    const index = episodes.findIndex((e) => e.id === item.id);
    tvNext = index >= 0 ? episodes[index + 1] ?? null : null;
  }).catch(() => {});
}

function tvUpdateTime() {
  const item = player.item;
  if (!item) return;
  const live = item.type === 'live';
  tvProgress.hidden = live;
  tvControls.hidden = live;
  if (live) {
    tvHint.textContent = 'Omhoog/omlaag: andere zender · OK: pauze · Terug: stoppen';
    return;
  }
  const position = player.base + (video.currentTime || 0);
  // Bij een aflevering die nog wordt omgezet, groeit de duur nog. Toon de lengte pas als die vaststaat.
  const known = tvKnownEnd();
  const total = known && Number.isFinite(video.duration) ? player.base + video.duration : 0;
  tvPos.textContent = clock(position);
  tvTotal.textContent = total ? clock(total) : '…';
  tvFill.style.width = total ? `${Math.min(100, (position / total) * 100)}%` : '0%';
  tvPlay.replaceChildren(icon(video.paused ? 'play' : 'pause', video.paused));
  tvPlay.setAttribute('aria-label', video.paused ? 'Afspelen' : 'Pauze');
  tvNextEp.hidden = !tvNextShown;
  tvHint.textContent = 'Terug: stoppen';
}

function tvSeek(seconds) {
  const { seekable } = video;
  if (!seekable.length) return;
  const end = seekable.end(seekable.length - 1) - 1;
  video.currentTime = Math.max(seekable.start(0), Math.min(end, video.currentTime + seconds));
}

function tvClosePlayer() {
  const id = player.item?.id;
  stopPlayback();
  stage.classList.remove('show-bar');
  const row = document.querySelector(`.row[data-id="${id}"] .row-main, .tile[data-id="${id}"], .live-tile[data-id="${id}"]`);
  if (row) tvFocus(row);
  else tvFocusDefault();
}

/** Toetsen tijdens het kijken. Geeft true als de toets is gebruikt. */
function tvPlayerKey(key) {
  const live = player.item?.type === 'live';
  const retry = videoMsg.classList.contains('show') && videoMsg.querySelector('button');
  // Staat de balk open, dan gaan links/rechts langs de knoppen. Anders spoelen ze meteen.
  const moveFocus = (step) => {
    const list = tvControlList();
    const index = list.indexOf(document.activeElement);
    tvShowBar(list[Math.max(0, Math.min(list.length - 1, index + step))]);
  };
  switch (key) {
    case 'ArrowUp': case 'ChannelUp':
      if (live) zap(-1);
      tvShowBar();
      return true;
    case 'ArrowDown': case 'ChannelDown':
      if (live) zap(1);
      tvShowBar();
      return true;
    case 'ArrowLeft':
      if (live) tvShowBar();
      else if (tvBarOpen() && tvInControls()) moveFocus(-1);
      else {
        tvSeek(-10);
        tvShowBar(tvBack10);
      }
      return true;
    case 'ArrowRight':
      if (live) tvShowBar();
      else if (tvBarOpen() && tvInControls()) moveFocus(1);
      else {
        tvSeek(10);
        tvShowBar(tvFwd10);
      }
      return true;
    case 'Rewind':
      if (!live) tvSeek(-30);
      tvShowBar(live ? undefined : tvBack10);
      return true;
    case 'Forward':
      if (!live) tvSeek(30);
      tvShowBar(live ? undefined : tvFwd10);
      return true;
    case 'Enter': case ' ':
      if (retry) retry.click();
      else if (!live && tvBarOpen() && tvInControls()) {
        const focused = document.activeElement;
        focused.click();
        if (focused !== tvNextEp) tvShowBar(focused);
      } else {
        tvTogglePlay();
        tvShowBar();
      }
      return true;
    case 'PlayPause': case 'MediaPlayPause':
      tvTogglePlay();
      tvShowBar();
      return true;
    case 'Play': case 'MediaPlay':
      video.play().catch(() => {});
      tvShowBar();
      return true;
    case 'Pause': case 'MediaPause':
      video.pause();
      tvShowBar();
      return true;
    case 'Info':
      tvShowBar();
      return true;
    case 'Stop': case 'MediaStop':
      tvClosePlayer();
      return true;
    default:
      if (BACK_KEYS.has(key)) {
        tvClosePlayer();
        return true;
      }
      return false;
  }
}

/** De Terug-knop. Geeft false als de app moet sluiten. */
function tvBack() {
  if (stage.classList.contains('active')) {
    tvClosePlayer();
    return true;
  }
  const active = document.activeElement;
  if (active?.matches?.('input, textarea')) {
    active.blur();
    tvFocusDefault();
    return true;
  }
  const hash = location.hash || '#/home';
  if (hash.startsWith('#/item/')) {
    history.back();
    return true;
  }
  if (state.user && hash !== '#/home') {
    location.hash = '#/home';
    return true;
  }
  return false;
}

// De Android-app stuurt hier de Terug-, zender- en mediaknoppen van de afstandsbediening heen.
window.kijkboxKey = (name) => {
  if (name === 'Back') return tvBack();
  if (stage.classList.contains('active')) return tvPlayerKey(name);
  return false;
};

// Op de tv opent een tekstveld anders meteen het schermtoetsenbord zodra je erlangs navigeert.
// Daarom staan tekstvelden op "alleen lezen" tot je er OK op drukt.
const TEXT_FIELD = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]), textarea';

function tvLockField(el) {
  if (el.dataset.tvEditing) return;
  el.readOnly = true;
  el.dataset.tvLocked = '1';
}

function tvUnlockField(el) {
  el.readOnly = false;
  el.dataset.tvEditing = '1';
  // Opnieuw selecteren, zodat Android het toetsenbord nu wel opent.
  el.blur();
  el.focus();
}

if (TV) {
  new MutationObserver(() => {
    for (const el of document.querySelectorAll(TEXT_FIELD)) if (!el.dataset.tvLocked) tvLockField(el);
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('focusout', (event) => {
    const el = event.target;
    if (!el.matches?.(TEXT_FIELD) || !el.dataset.tvEditing) return;
    // Bij het opnieuw selecteren in tvUnlockField verliest het veld heel even de focus; dat telt niet.
    setTimeout(() => {
      if (document.activeElement === el) return;
      delete el.dataset.tvEditing;
      tvLockField(el);
    }, 0);
  });

  document.addEventListener('keydown', (event) => {
    if (stage.classList.contains('active')) {
      if (tvPlayerKey(event.key)) event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && event.target.matches?.(TEXT_FIELD) && event.target.readOnly) {
      event.preventDefault();
      tvUnlockField(event.target);
      return;
    }
    const typing = event.target.matches?.('input, textarea') && !event.target.readOnly;
    const direction = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    if (direction) {
      if (typing && (direction === 'left' || direction === 'right')) return;
      event.preventDefault();
      tvMove(direction);
    } else if ((event.key === 'MediaPlayPause' || event.key === 'MediaPlay') && document.activeElement?.resumeItem) {
      event.preventDefault();
      resumeFromPoster(document.activeElement.resumeItem);
    } else if (BACK_KEYS.has(event.key) && !typing) {
      event.preventDefault();
      tvBack();
    }
  }, true);
}

function renderApp() {
  const app = document.getElementById('app');
  applyTheme(state.user?.theme ?? '');
  applyAppearance(state.user?.appearance ?? '');
  if (state.user) applyLook(state.user.look ?? {});
  // Ander account (of opnieuw opgebouwd): geen bewaarde lijsten van de vorige.
  for (const key of Object.keys(posterCache)) delete posterCache[key];
  lastRoute = '';
  // Na inloggen weten we nog niet of ondertitels zijn ingesteld; dat staat in /api/state.
  if (state.user && state.subtitles === undefined) {
    state.subtitles = false;
    fetch('/api/state').then((r) => r.json()).then((s) => { state.subtitles = Boolean(s.subtitles); updateCcButtons(); }).catch(() => {});
  }
  if (state.needsSetup) return app.replaceChildren(setupScreen());
  if (!state.user) return app.replaceChildren(TV ? (state.profiles ? profileScreen() : pairScreen()) : loginScreen());
  if (state.user.mustChangePassword) return app.replaceChildren(newPasswordScreen());
  // Op de tv bij het opstarten eerst kiezen wie er kijkt (zoals bij Netflix).
  if (TV && state.profiles && !profileChosen()) return app.replaceChildren(profileScreen());
  viewEl = h('main', { class: 'view' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Hoofdmenu' },
    // Op de plek van het logo: je eigen profielfoto (naar Account).
    h('a', { class: 'nav-profile', href: '#/instellingen', title: `${state.user.username} – Account`, 'aria-label': 'Account' },
      h('span', { class: 'nav-avatar' }, avatar(state.user, { self: true }))),
    NAV.map(([href, iconName, label]) => h('a', { href }, icon(iconName), label)),
    h('a', { class: 'bottom', href: '#/instellingen' }, icon('user'), h('span', { class: 'nav-avatar mini' }, avatar(state.user, { self: true })), 'Account'));
  app.replaceChildren(h('div', { class: `shell${player.item ? '' : ' idle'}` }, nav, stage, viewEl));
  route();
}

window.addEventListener('hashchange', route);

const initial = await fetch(TV ? '/api/state?tv=1' : '/api/state').then((r) => r.json());
state.profiles = initial.profiles ?? 0;
state.user = initial.user;
state.subtitles = initial.user ? Boolean(initial.subtitles) : undefined;
state.needsSetup = initial.needsSetup;
renderApp();

// ---- Nieuwe versie op de server
// Na een update draait de server meteen de nieuwe versie, maar een pagina die al open stond (of de
// tv-app, die dagen open blijft) heeft nog de oude code. Dan de pagina vernieuwen.
const loadedVersion = initial.version;
let updateNotice = null;

function reloadForUpdate() {
  saveProgress(true);
  location.reload();
}

async function checkVersion() {
  if (!loadedVersion || updateNotice) return;
  let version;
  try {
    ({ version } = await fetch('/api/state').then((r) => r.json()));
  } catch {
    return;
  }
  if (!version || version === loadedVersion) return;
  // Speelt er niets en kijkt niemand naar de pagina, dan kan het meteen.
  if (!player.item && document.visibilityState === 'hidden') return reloadForUpdate();
  updateNotice = h('div', { class: 'update-notice', role: 'status' },
    h('span', {}, `Kijkbox is bijgewerkt naar versie ${version}.`),
    h('button', { class: 'btn compact primary', onclick: reloadForUpdate }, 'Nu vernieuwen'));
  document.body.append(updateNotice);
}

setInterval(checkVersion, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkVersion();
});
