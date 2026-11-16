// Mission Control — phone admin page.

const { esc, api, dayLabel, DAYS } = MC;
const $ = (id) => document.getElementById(id);

let C = null; // full config from /api/config

// ---------- feedback ----------
let savedTimer;
function saved(ok = true, msg) {
  const el = $('saved');
  el.hidden = false;
  el.textContent = ok ? 'Saved ✓' : `Error: ${msg}`;
  el.style.color = ok ? '' : 'var(--danger)';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.hidden = true), ok ? 1500 : 5000);
}
async function save(path, body, method = 'PUT') {
  try { const r = await api(path, { method, body }); saved(); return r; }
  catch (e) { saved(false, e.message); throw e; }
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'today') renderToday();
  window.scrollTo(0, 0);
}));

const personOptions = (selected, anyone = 'Anyone') =>
  `<option value="">${anyone}</option>` + C.people.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

// ---------- today ----------
async function renderToday() {
  const { date, chores } = await api('/api/chores');
  $('today-label').textContent = `Today’s chores · ${dayLabel(date, { weekday: 'long', month: 'short', day: 'numeric' })}`;
  const groups = [...C.people, { id: null, name: 'Anyone', color: '#9aa4b2' }]
    .map((p) => ({ p, list: chores.filter((c) => (c.personId || null) === p.id) }))
    .filter((g) => g.list.length);
  $('today-chores').innerHTML = groups.length ? groups.map(({ p, list }) => `
    <div class="card">
      <div class="who"><span class="dot" style="--c:${p.color}"></span>${esc(p.name)}</div>
      ${list.map((c) => `<button class="tick ${c.done ? 'done' : ''}" data-id="${c.id}"><span class="box"></span>${esc(c.title)}</button>`).join('')}
    </div>`).join('') : '<p class="hint">No chores today. Add some in the Chores tab.</p>';
}
$('today-chores').addEventListener('click', async (e) => {
  const btn = e.target.closest('.tick');
  if (!btn) return;
  const done = !btn.classList.contains('done');
  btn.classList.toggle('done', done); // optimistic
  try { await api('/api/toggle', { method: 'POST', body: { choreId: btn.dataset.id } }); }
  catch (err) { saved(false, err.message); renderToday(); }
});

// ---------- meals ----------
function renderMeals() {
  const [y, m, d] = C.today.split('-').map(Number);
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const key = dt.toISOString().slice(0, 10);
    const meal = C.meals[key] || {};
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(key, { weekday: 'long' });
    rows.push(`<div class="card meal-day" data-date="${key}">
      <div class="day">${label}<small>${dayLabel(key, { month: 'short', day: 'numeric' })}</small></div>
      <input data-k="lunch" placeholder="Lunch" value="${esc(meal.lunch || '')}">
      <input data-k="dinner" placeholder="Dinner" value="${esc(meal.dinner || '')}">
    </div>`);
  }
  $('meal-days').innerHTML = rows.join('');
}
$('meal-days').addEventListener('change', async (e) => {
  const card = e.target.closest('.meal-day');
  const body = { lunch: card.querySelector('[data-k=lunch]').value, dinner: card.querySelector('[data-k=dinner]').value };
  await save(`/api/meals/${card.dataset.date}`, body);
  C.meals[card.dataset.date] = body;
});

// ---------- chores ----------
function renderChoreEditor() {
  $('chore-list').innerHTML = C.chores.map((c, i) => `
    <div class="card" data-i="${i}">
      <div class="row">
        <input data-k="title" value="${esc(c.title)}" placeholder="Chore">
        <button class="btn danger" data-act="del" aria-label="Delete">✕</button>
      </div>
      <div class="row" style="margin-top:.5rem"><select data-k="personId">${personOptions(c.personId)}</select></div>
      <div class="days">${DAYS.map((d, n) => `<button data-day="${n}" class="${c.days.includes(n) ? 'on' : ''}">${d[0]}</button>`).join('')}</div>
    </div>`).join('') || '<p class="hint">No chores yet.</p>';
}
async function saveChores() {
  const r = await save('/api/chores', C.chores);
  C.chores = r.chores;
}
$('chore-list').addEventListener('change', (e) => {
  const i = e.target.closest('[data-i]').dataset.i;
  C.chores[i][e.target.dataset.k] = e.target.value || null;
  saveChores();
});
$('chore-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-i]');
  if (!card) return;
  const c = C.chores[card.dataset.i];
  if (e.target.dataset.act === 'del') {
    if (!confirm(`Delete “${c.title}”?`)) return;
    C.chores.splice(card.dataset.i, 1);
    saveChores().then(renderChoreEditor);
  } else if (e.target.dataset.day) {
    const n = Number(e.target.dataset.day);
    c.days = c.days.includes(n) ? c.days.filter((x) => x !== n) : [...c.days, n].sort();
    e.target.classList.toggle('on');
    saveChores();
  }
});
$('add-chore').addEventListener('click', async () => {
  C.chores.push({ title: 'New chore', personId: C.people[0]?.id || null, days: [] });
  await saveChores();
  renderChoreEditor();
  const inputs = $('chore-list').querySelectorAll('[data-k=title]');
  inputs[inputs.length - 1]?.select();
});

// ---------- family & calendars ----------
function renderFamily() {
  $('people').innerHTML = C.people.map((p, i) => `
    <div class="card row" data-i="${i}">
      <input type="color" data-k="color" value="${p.color}">
      <input data-k="name" value="${esc(p.name)}" placeholder="Name">
      <button class="btn danger" data-act="del" aria-label="Remove">✕</button>
    </div>`).join('');
  $('calendars').innerHTML = C.calendars.map((c, i) => `
    <div class="card" data-i="${i}">
      <div class="row">
        <input data-k="name" value="${esc(c.name)}" placeholder="Name (e.g. Family)">
        <button class="btn danger" data-act="del" aria-label="Remove">✕</button>
      </div>
      <input data-k="url" value="${esc(c.url)}" placeholder="webcal://…icloud.com/published/… or https://…ics" style="margin-top:.5rem" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="row" style="margin-top:.5rem">
        <select data-k="personId">${personOptions(c.personId, 'Shared / family')}</select>
        <input type="color" data-k="color" value="${c.color}" title="Color for shared calendars">
      </div>
      <div class="cal-status" data-status="${c.id}">${c.url ? 'Checking…' : ''}</div>
    </div>`).join('') || '<p class="hint">No calendars yet.</p>';
  checkCalendars();
}
async function checkCalendars() {
  if (!C.calendars.some((c) => c.url)) return;
  for (const c of C.calendars) {
    const el = document.querySelector(`[data-status="${c.id}"]`);
    if (el) { el.textContent = c.url ? 'Checking…' : ''; el.className = 'cal-status'; }
  }
  try {
    const { results } = await api('/api/calendars/status');
    for (const r of results) {
      const el = document.querySelector(`[data-status="${r.id}"]`);
      if (el) { el.textContent = (r.ok ? '✓ ' : '✕ ') + r.message; el.className = `cal-status ${r.ok ? 'ok' : 'bad'}`; }
    }
  } catch (err) { console.warn(err); }
}
function bindList(containerId, key, after) {
  $(containerId).addEventListener('change', async (e) => {
    const i = e.target.closest('[data-i]').dataset.i;
    C[key][i][e.target.dataset.k] = e.target.value || (e.target.dataset.k === 'personId' ? null : '');
    const r = await save(`/api/${key}`, C[key]);
    C[key] = r[key];
    after?.();
  });
  $(containerId).addEventListener('click', async (e) => {
    if (e.target.dataset.act !== 'del') return;
    const i = e.target.closest('[data-i]').dataset.i;
    if (!confirm(`Remove “${C[key][i].name}”?`)) return;
    C[key].splice(i, 1);
    const r = await save(`/api/${key}`, C[key]);
    C[key] = r[key];
    renderFamily(); after?.();
  });
}
bindList('people', 'people', renderChoreEditor);
bindList('calendars', 'calendars', checkCalendars); // re-check links after any edit
const PALETTE = ['#4f9dff', '#ff7eb6', '#ffb84f', '#5fd38d', '#b48cff', '#ff6b5f', '#4fd5e0'];
$('add-person').addEventListener('click', async () => {
  C.people.push({ name: 'New person', color: PALETTE[C.people.length % PALETTE.length] });
  C.people = (await save('/api/people', C.people)).people;
  renderFamily(); renderChoreEditor();
});
$('add-calendar').addEventListener('click', async () => {
  C.calendars.push({ name: 'Calendar', url: '', personId: null, color: '#9aa4b2' });
  C.calendars = (await save('/api/calendars', C.calendars)).calendars;
  renderFamily();
});

// ---------- settings ----------
function renderSettings() {
  const f = $('settings'), s = C.settings;
  for (const k of ['householdName', 'message', 'timezone', 'units', 'nightStart', 'nightEnd']) f.elements[k].value = s[k] ?? '';
  f.elements.clock24h.checked = !!s.clock24h;
  $('loc-current').textContent = s.latitude != null ? `Current: ${s.locationName || `${s.latitude}, ${s.longitude}`}` : 'No location set — weather is off.';
  $('title').textContent = s.householdName || 'Mission Control';
}
$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(['householdName', 'message', 'timezone', 'units', 'nightStart', 'nightEnd'].map((k) => [k, f.elements[k].value]));
  body.clock24h = f.elements.clock24h.checked;
  C.settings = (await save('/api/settings', body)).settings;
  renderSettings();
});
$('city-search').addEventListener('click', async () => {
  const q = $('city').value.trim();
  if (!q) return;
  try {
    const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    $('city-results').innerHTML = results.length
      ? `<div class="results">${results.map((r, i) => `<button type="button" class="btn" data-i="${i}">${esc(r.name)}</button>`).join('')}</div>`
      : '<p class="hint">No matches.</p>';
    $('city-results').onclick = async (e) => {
      const r = results[e.target.dataset.i];
      if (!r) return;
      const body = { latitude: r.latitude, longitude: r.longitude, locationName: r.name };
      if (!C.settings.timezone && r.timezone) body.timezone = r.timezone;
      C.settings = (await save('/api/settings', body)).settings;
      $('city-results').innerHTML = '';
      $('city').value = '';
      renderSettings();
    };
  } catch (err) { saved(false, err.message); }
});
$('city').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('city-search').click(); } });

// ---------- boot ----------
(async () => {
  C = await api('/api/config');
  renderSettings(); renderMeals(); renderChoreEditor(); renderFamily(); renderToday();
})();
