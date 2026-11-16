// Mission Control — TV display logic. Polls the server; nothing here needs a remote or touch.

const { esc, api, dayLabel, weatherIcon, WX_TEXT } = MC;
const $ = (id) => document.getElementById(id);

let S = null;          // latest /api/state
let EV = { days: [] }; // latest /api/events
let WX = null;         // latest /api/weather
let bootId = null;

const tz = () => S?.settings?.timezone || undefined;
const fmt = (date, opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz(), ...opts }).format(date);

function fmtTime(date, { short = false } = {}) {
  if (S?.settings?.clock24h) return fmt(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).formatToParts(date);
  const h = parts.find((p) => p.type === 'hour').value;
  const m = parts.find((p) => p.type === 'minute').value;
  const ap = parts.find((p) => p.type === 'dayPeriod')?.value || '';
  if (short) return m === '00' ? `${h}${ap.toLowerCase()[0]}` : `${h}:${m}${ap.toLowerCase()[0]}`;
  return { hm: `${h}:${m}`, ap };
}

function minutesNow() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value);
}
const toMin = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + m; };

// ---------- clock + night mode ----------
function tick() {
  const now = new Date();
  if (S?.settings?.clock24h) $('time').textContent = fmtTime(now);
  else { const t = fmtTime(now); $('time').innerHTML = `${t.hm}<span class="ampm">${t.ap}</span>`; }
  $('date').textContent = fmt(now, { weekday: 'long', month: 'long', day: 'numeric' });

  const ns = toMin(S?.settings?.nightStart), ne = toMin(S?.settings?.nightEnd), m = minutesNow();
  const night = S && ns !== ne && (ns < ne ? m >= ns && m < ne : m >= ns || m < ne);
  $('night').hidden = !night;
  if (night) {
    $('night-time').textContent = S.settings.clock24h ? fmtTime(now) : `${fmtTime(now).hm}`;
    $('night-date').textContent = fmt(now, { weekday: 'long', month: 'long', day: 'numeric' });
  }
}

// ---------- header ----------
function renderMessage() { $('message').textContent = S.settings.message || ''; }

function renderWeather() {
  const el = $('weather');
  if (!WX) { el.innerHTML = ''; return; }
  if (!WX.configured) { el.innerHTML = '<div class="wx-setup">Set your location in /admin for weather</div>'; return; }
  const deg = (n) => `${Math.round(n)}°`;
  const today = WX.daily[0];
  el.innerHTML = `
    <div class="wx-now">
      ${weatherIcon(WX.now.code, WX.now.isDay)}
      <div>
        <div class="wx-temp">${deg(WX.now.temp)}</div>
        <div class="wx-sub">${esc(WX_TEXT(WX.now.code))} · ${deg(today.hi)} / ${deg(today.lo)}${today.rain >= 30 ? ` · ${today.rain}% 💧` : ''}</div>
      </div>
    </div>`;
}

// ---------- today's schedule ----------
function renderToday() {
  const day = EV.days[0];
  const events = day?.events || [];
  const allDay = events.filter((e) => e.allDay);
  const timed = events.filter((e) => !e.allDay);
  const now = Date.now();

  $('allday').innerHTML = allDay.map((e) => `<span class="chip" style="--c:${e.color}">${esc(e.title)}</span>`).join('');

  if (!timed.length) {
    $('today').innerHTML = `<li class="empty">${allDay.length ? 'Nothing else on the calendar.' : 'Nothing on the calendar. Enjoy it.'}</li>`;
    return;
  }
  // Keep the list focused: drop events that ended a while ago if the day is busy.
  let list = timed;
  if (list.length > 7) list = list.filter((e) => new Date(e.end).getTime() > now - 60 * 60_000);
  $('today').innerHTML = list.slice(0, 8).map((e) => {
    const s = new Date(e.start), en = new Date(e.end);
    const cls = en.getTime() < now ? 'past' : s.getTime() <= now ? 'now' : '';
    const t = fmtTime(s);
    const when = S.settings.clock24h ? t : `${t.hm}<small>${t.ap}</small>`;
    return `<li class="event ${cls}" style="--c:${e.color}">
      <div class="when">${when}</div><div class="bar"></div>
      <div><div class="what">${esc(e.title)}</div><div class="who">${esc(e.who)}${e.location ? ' · ' + esc(e.location.split(',')[0]) : ''}</div></div>
    </li>`;
  }).join('');
}

// ---------- chores ----------
function renderChores() {
  const byPerson = new Map();
  for (const c of S.chores) {
    if (!byPerson.has(c.personId)) byPerson.set(c.personId, []);
    byPerson.get(c.personId).push(c);
  }
  const people = [...S.people, { id: null, name: 'Anyone', color: '#9aa4b2' }].filter((p) => byPerson.has(p.id));
  const total = S.chores.length, done = S.chores.filter((c) => c.done).length;
  $('chore-total').textContent = total ? `${done} of ${total} done` : '';

  if (!people.length) { $('chores').innerHTML = '<div class="empty">No chores today.</div>'; return; }
  $('chores').innerHTML = people.map((p) => {
    const list = byPerson.get(p.id);
    const d = list.filter((c) => c.done).length;
    const pct = Math.round((d / list.length) * 100);
    return `<div class="person" style="--c:${p.color}">
      <div class="person-head">
        <div class="avatar">${esc(p.name.trim()[0] || '?')}</div>
        <div class="person-name">${esc(p.name)}</div>
        ${d === list.length ? '<div class="all-done" title="All done">★</div>' : `<div class="person-count">${d}/${list.length}</div>`}
      </div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <ul class="chore-list">${list.map((c) => `<li class="chore ${c.done ? 'done' : ''}"><span class="check"></span>${esc(c.title)}</li>`).join('')}</ul>
    </div>`;
  }).join('');
}

// ---------- meals ----------
function renderMeals() {
  const [today, ...rest] = S.meals;
  const meal = (label, name) => `<div class="meal"><div class="meal-label">${label}</div>
    <div class="meal-name ${name ? '' : 'unplanned'}">${name ? esc(name) : 'Not planned yet'}</div></div>`;
  $('meals-today').innerHTML = meal('Lunch', today.lunch) + meal('Dinner', today.dinner);
  $('meals-week').innerHTML = rest.map((m) =>
    `<li><span class="d">${dayLabel(m.date)}</span>${m.dinner ? `<span>${esc(m.dinner)}</span>` : '<span class="tbd">—</span>'}</li>`).join('');
}

// ---------- week ahead ----------
function renderWeek() {
  const wxByDate = Object.fromEntries((WX?.daily || []).map((d) => [d.date, d]));
  $('week').innerHTML = EV.days.slice(1, 6).map((day, i) => {
    const wx = wxByDate[day.date];
    const shown = day.events.slice(0, 3);
    const more = day.events.length - shown.length;
    return `<div class="wday">
      <div class="wday-head">
        <div class="wday-name">${i === 0 ? 'Tomorrow' : dayLabel(day.date, { weekday: 'long' })}</div>
        ${wx ? `<div class="wday-wx">${weatherIcon(wx.code)}${Math.round(wx.hi)}°/${Math.round(wx.lo)}°</div>` : ''}
      </div>
      ${shown.map((e) => `<div class="wday-ev" style="--c:${e.color}">${e.allDay ? '' : `<span class="t">${fmtTime(new Date(e.start), { short: true })}</span>`}<span>${esc(e.title)}</span></div>`).join('')}
      ${more > 0 ? `<div class="wday-more">+${more} more</div>` : ''}
      ${!day.events.length ? '<div class="wday-more">Free</div>' : ''}
    </div>`;
  }).join('');
}

// ---------- data loading ----------
function setStatus(msg) { $('status').hidden = !msg; $('status').textContent = msg || ''; }

async function loadState() {
  try {
    const next = await api('/api/state');
    if (bootId && next.bootId !== bootId) return location.reload(); // server restarted/updated
    const dayChanged = S && S.today !== next.today;
    bootId = next.bootId; S = next;
    renderMessage(); renderChores(); renderMeals(); tick();
    if (dayChanged) { loadEvents(); loadWeather(); }
    setStatus('');
  } catch { setStatus('Can’t reach Mission Control server — retrying…'); }
}

async function loadEvents() {
  try {
    EV = await api('/api/events?days=6');
    if (S) { renderToday(); renderWeek(); }
    if (EV.errors?.length) console.warn('Calendar errors', EV.errors);
  } catch (e) { console.warn(e); }
}

async function loadWeather() {
  try { WX = await api('/api/weather'); renderWeather(); renderWeek(); } catch (e) { console.warn(e); }
}

(async function start() {
  await loadState();
  await Promise.all([loadEvents(), loadWeather()]);
  setInterval(tick, 1000);
  setInterval(loadState, 15_000);                 // chores ticked on a phone show up within ~15s
  setInterval(loadEvents, 5 * 60_000);
  setInterval(() => { if (S) renderToday(); }, 60_000); // "NOW"/past styling
  setInterval(loadWeather, 15 * 60_000);
  // Full refresh once a night — keeps long-running TV browsers healthy.
  setInterval(() => { if (minutesNow() === 3 * 60 + 30) location.reload(); }, 60_000);
})();
