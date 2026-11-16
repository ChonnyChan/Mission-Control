// Mission Control — family dashboard server.
// Serves the TV display (/), the phone admin page (/admin), and a small JSON API.
// All household data lives in data/db.json (git-ignored).

import express from 'express';
import ical from 'node-ical';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BOOT_ID = crypto.randomUUID(); // the TV reloads itself when this changes (i.e. after a restart/update)

// ---------- storage ----------

function seed() {
  // Placeholder household — rename/replace everything from the admin page.
  const p = (name, color) => ({ id: crypto.randomUUID(), name, color });
  const people = [p('Jon', '#4f9dff'), p('Partner', '#ff7eb6'), p('Kid 1', '#ffb84f'), p('Kid 2', '#5fd38d')];
  const every = [0, 1, 2, 3, 4, 5, 6];
  const school = [1, 2, 3, 4, 5];
  const c = (title, personIdx, days = every) => ({ id: crypto.randomUUID(), title, personId: people[personIdx].id, days });
  return {
    settings: {
      householdName: 'Mission Control',
      message: 'Welcome to Mission Control 🚀',
      timezone: '',
      latitude: null,
      longitude: null,
      locationName: '',
      units: 'fahrenheit',
      clock24h: false,
      nightStart: '22:00',
      nightEnd: '06:00',
      calendarRefreshMinutes: 10,
    },
    people,
    calendars: [], // { id, name, url, personId|null, color }
    chores: [
      c('Make bed', 2), c('Feed the cat', 2), c('Pack school bag', 2, school),
      c('Make bed', 3), c('Set the table', 3), c('Tidy toys', 3),
      c('Take out trash', 0, [1, 4]), c('Run dishwasher', 1),
    ],
    completions: {}, // { 'YYYY-MM-DD': [choreId, ...] }
    meals: {},       // { 'YYYY-MM-DD': { lunch, dinner } }
  };
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // don't silently overwrite a corrupt file
    const db = seed();
    saveDb(db);
    return db;
  }
}

function saveDb(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomic-ish: never leaves a half-written db
}

let db = loadDb();
applyTimezone();

function applyTimezone() {
  if (db.settings.timezone) process.env.TZ = db.settings.timezone;
}

// ---------- date helpers (server local time) ----------

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const isDateKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k);

function pruneOld() {
  const cutoff = dayKey(addDays(new Date(), -400));
  for (const k of Object.keys(db.completions)) if (k < cutoff) delete db.completions[k];
  const mealCutoff = dayKey(addDays(new Date(), -60));
  for (const k of Object.keys(db.meals)) if (k < mealCutoff) delete db.meals[k];
}

// ---------- calendars ----------

const icsCache = new Map(); // url -> { at, data }

async function fetchCalendar(url) {
  const ttl = (db.settings.calendarRefreshMinutes || 10) * 60_000;
  const hit = icsCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  // webcal:// (what iCloud and Apple hand out) is just https:// with a different label.
  const res = await fetch(url.trim().replace(/^webcals?:/i, 'https:'), {
    headers: { 'User-Agent': 'MissionControl/0.1 (home dashboard)', Accept: 'text/calendar, */*' },
    redirect: 'follow', // iCloud often redirects to a different pXX-caldav host
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link didn’t return a calendar file');
  const data = ical.sync.parseICS(text);
  icsCache.set(url, { at: Date.now(), data });
  return data;
}

async function getEvents(days) {
  const from = startOfDay(new Date());
  const to = addDays(from, days);
  const peopleById = Object.fromEntries(db.people.map((p) => [p.id, p]));
  const out = [];
  const errors = [];

  await Promise.all(db.calendars.filter((c) => c.url).map(async (cal) => {
    let data;
    try {
      data = await fetchCalendar(cal.url);
    } catch (err) {
      const stale = icsCache.get(cal.url); // keep showing the last good copy if the fetch fails
      if (!stale) { errors.push({ calendar: cal.name, error: String(err.message || err) }); return; }
      data = stale.data;
    }
    const person = peopleById[cal.personId];
    for (const ev of Object.values(data)) {
      if (ev.type !== 'VEVENT' || ev.status === 'CANCELLED') continue;
      let instances;
      try {
        instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
      } catch { continue; }
      for (const i of instances) {
        const start = new Date(i.start);
        const end = i.end ? new Date(i.end) : new Date(start.getTime() + (i.isFullDay ? 86_400_000 : 0));
        if (end <= from && !(end.getTime() === start.getTime() && start >= from)) continue;
        if (start >= to) continue;
        out.push({
          title: (typeof i.summary === 'object' ? i.summary?.val : i.summary) || '(busy)',
          start: start.toISOString(),
          end: end.toISOString(),
          allDay: !!i.isFullDay,
          location: typeof ev.location === 'string' ? ev.location : '',
          personId: person?.id || null,
          who: person?.name || cal.name,
          color: person?.color || cal.color || '#9aa4b2',
        });
      }
    }
  }));

  // Bucket by local day; multi-day events appear on every day they cover.
  const byDay = [];
  for (let n = 0; n < days; n++) {
    const dStart = addDays(from, n);
    const dEnd = addDays(from, n + 1);
    const events = out
      .filter((e) => {
        const s = new Date(e.start), en = new Date(e.end);
        return s < dEnd && (en > dStart || (s >= dStart && en.getTime() === s.getTime()));
      })
      .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    byDay.push({ date: dayKey(dStart), events });
  }
  return { days: byDay, errors };
}

// ---------- weather (Open-Meteo, no API key) ----------

let weatherCache = { at: 0, key: '', data: null };

async function getWeather() {
  const { latitude, longitude, units } = db.settings;
  if (latitude == null || longitude == null) return { configured: false };
  const key = `${latitude},${longitude},${units}`;
  if (weatherCache.key === key && Date.now() - weatherCache.at < 15 * 60_000) return weatherCache.data;
  const q = new URLSearchParams({
    latitude, longitude,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: units === 'celsius' ? 'celsius' : 'fahrenheit',
    timezone: 'auto',
    forecast_days: '6',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  const j = await res.json();
  const data = {
    configured: true,
    now: { temp: j.current.temperature_2m, feels: j.current.apparent_temperature, code: j.current.weather_code, isDay: !!j.current.is_day },
    daily: j.daily.time.map((date, i) => ({
      date, code: j.daily.weather_code[i], hi: j.daily.temperature_2m_max[i], lo: j.daily.temperature_2m_min[i],
      rain: j.daily.precipitation_probability_max[i],
    })),
  };
  weatherCache = { at: Date.now(), key, data };
  return data;
}

// ---------- state for the display ----------

function choresFor(date) {
  const dow = date.getDay();
  const done = new Set(db.completions[dayKey(date)] || []);
  return db.chores
    .filter((c) => !c.days?.length || c.days.includes(dow))
    .map((c) => ({ ...c, done: done.has(c.id) }));
}

function publicSettings() {
  const { householdName, message, units, clock24h, nightStart, nightEnd, locationName, timezone } = db.settings;
  return { householdName, message, units, clock24h, nightStart, nightEnd, locationName, timezone };
}

function state() {
  const today = startOfDay(new Date());
  const meals = [];
  for (let n = 0; n < 7; n++) {
    const k = dayKey(addDays(today, n));
    meals.push({ date: k, ...(db.meals[k] || {}) });
  }
  return {
    bootId: BOOT_ID,
    today: dayKey(today),
    settings: publicSettings(),
    people: db.people,
    chores: choresFor(today),
    meals,
  };
}

// ---------- HTTP ----------

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: String(err.message || err) });
});

app.get('/api/state', (req, res) => res.json(state()));

app.get('/api/events', wrap(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
  res.json(await getEvents(days));
}));

app.get('/api/weather', wrap(async (req, res) => res.json(await getWeather())));

// Full config for the admin page (includes private calendar URLs — LAN only).
app.get('/api/config', (req, res) => {
  const { completions, ...rest } = db;
  res.json({ ...rest, today: dayKey(new Date()) });
});

app.get('/api/chores', (req, res) => {
  const date = isDateKey(req.query.date || '') ? parseKey(req.query.date) : startOfDay(new Date());
  res.json({ date: dayKey(date), chores: choresFor(date) });
});

app.post('/api/toggle', (req, res) => {
  const { choreId } = req.body || {};
  const date = isDateKey(req.body?.date || '') ? req.body.date : dayKey(new Date());
  if (!db.chores.some((c) => c.id === choreId)) return res.status(404).json({ error: 'unknown chore' });
  const list = new Set(db.completions[date] || []);
  list.has(choreId) ? list.delete(choreId) : list.add(choreId);
  db.completions[date] = [...list];
  pruneOld();
  saveDb(db);
  res.json({ ok: true, done: list.has(choreId) });
});

app.put('/api/meals/:date', (req, res) => {
  if (!isDateKey(req.params.date)) return res.status(400).json({ error: 'bad date' });
  const clean = (s) => String(s ?? '').slice(0, 200).trim();
  const entry = { lunch: clean(req.body?.lunch), dinner: clean(req.body?.dinner) };
  if (entry.lunch || entry.dinner) db.meals[req.params.date] = entry;
  else delete db.meals[req.params.date];
  saveDb(db);
  res.json({ ok: true });
});

// Whole-list replacement for the small collections the admin page edits.
const str = (v, max = 200) => String(v ?? '').slice(0, max).trim();
const color = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : '#9aa4b2');
const id = (v) => (typeof v === 'string' && v ? v : crypto.randomUUID());

const sanitizers = {
  people: (p) => ({ id: id(p.id), name: str(p.name, 40) || 'Someone', color: color(p.color) }),
  calendars: (c) => ({ id: id(c.id), name: str(c.name, 60) || 'Calendar', url: str(c.url, 2000), personId: c.personId || null, color: color(c.color) }),
  chores: (c) => ({
    id: id(c.id), title: str(c.title, 80) || 'Chore', personId: c.personId || null,
    days: Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [],
  }),
};

for (const [name, clean] of Object.entries(sanitizers)) {
  app.put(`/api/${name}`, (req, res) => {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
    db[name] = req.body.slice(0, 200).map(clean);
    if (name === 'calendars') icsCache.clear();
    saveDb(db);
    res.json({ ok: true, [name]: db[name] });
  });
}

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  const time = (v, fallback) => (/^\d{2}:\d{2}$/.test(v || '') ? v : fallback);
  const num = (v) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  db.settings = {
    ...s,
    householdName: str(b.householdName ?? s.householdName, 60),
    message: str(b.message ?? s.message, 200),
    timezone: str(b.timezone ?? s.timezone, 60),
    latitude: 'latitude' in b ? num(b.latitude) : s.latitude,
    longitude: 'longitude' in b ? num(b.longitude) : s.longitude,
    locationName: str(b.locationName ?? s.locationName, 100),
    units: b.units === 'celsius' ? 'celsius' : b.units === 'fahrenheit' ? 'fahrenheit' : s.units,
    clock24h: 'clock24h' in b ? !!b.clock24h : s.clock24h,
    nightStart: time(b.nightStart, s.nightStart),
    nightEnd: time(b.nightEnd, s.nightEnd),
    calendarRefreshMinutes: Math.min(Math.max(Number(b.calendarRefreshMinutes) || s.calendarRefreshMinutes, 1), 240),
  };
  if (db.settings.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: db.settings.timezone }); } catch { db.settings.timezone = s.timezone; }
  }
  applyTimezone();
  saveDb(db);
  res.json({ ok: true, settings: db.settings });
});

// City search for the weather location (Open-Meteo geocoding).
// Per-calendar health check for the admin page: does each link load, and how much is in it?
app.get('/api/calendars/status', wrap(async (req, res) => {
  const friendly = (msg) =>
    /HTTP 40[34]/.test(msg) ? `${msg}: link not found or not public. Is “Public Calendar” still on?`
    : /timeout|aborted/i.test(msg) ? 'Timed out reaching the calendar. Check the internet connection.'
    : /fetch failed|ENOTFOUND|EAI_AGAIN/i.test(msg) ? 'Couldn’t reach that address. Check the link was copied in full.'
    : msg;
  const results = await Promise.all(db.calendars.map(async (c) => {
    if (!c.url) return { id: c.id, ok: false, message: 'No link yet' };
    try {
      const data = await fetchCalendar(c.url);
      const now = Date.now();
      const events = Object.values(data).filter((e) => e.type === 'VEVENT');
      const upcoming = events.filter((e) => e.rrule || (e.end || e.start) >= now).length;
      return { id: c.id, ok: true, message: `Connected: ${events.length} events (${upcoming} upcoming or repeating)` };
    } catch (err) {
      return { id: c.id, ok: false, message: friendly(String(err.message || err)) };
    }
  }));
  res.json({ results });
}));

app.get('/api/geocode', wrap(async (req, res) => {
  const q = str(req.query.q, 100);
  if (!q) return res.json({ results: [] });
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&name=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  res.json({
    results: (j.results || []).map((x) => ({
      name: [x.name, x.admin1, x.country_code].filter(Boolean).join(', '),
      latitude: x.latitude, longitude: x.longitude, timezone: x.timezone,
    })),
  });
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mission Control running:  TV → http://localhost:${PORT}/   Phone admin → http://<this-computer's-IP>:${PORT}/admin`);
});
