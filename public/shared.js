// Helpers shared by the TV display and the admin page.

const MC = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // 'YYYY-MM-DD' → label, without timezone surprises.
  function dayLabel(key, opts = { weekday: 'short' }) {
    const [y, m, d] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---- weather icons (WMO codes from Open-Meteo) ----
  const SUN = '<circle cx="32" cy="32" r="11" fill="#ffc94d"/><g stroke="#ffc94d" stroke-width="4" stroke-linecap="round"><path d="M32 8v6M32 50v6M8 32h6M50 32h6M15 15l4 4M45 45l4 4M15 49l4-4M45 19l4-4"/></g>';
  const MOON = '<path d="M40 12a20 20 0 1 0 12 30A16 16 0 0 1 40 12z" fill="#c9d4ff"/>';
  const CLOUD = (fill = '#d6deeb', dy = 0) => `<path transform="translate(0 ${dy})" d="M18 50h30a11 11 0 0 0 1-22 15 15 0 0 0-29-2 12 12 0 0 0-2 24z" fill="${fill}"/>`;
  const SMALL_SUN = '<g transform="translate(-6 -8) scale(.8)">' + SUN + '</g>';
  const SMALL_MOON = '<g transform="translate(-4 -6) scale(.8)">' + MOON + '</g>';

  function weatherIcon(code, isDay = true) {
    let body;
    if (code === 0) body = isDay ? SUN : MOON;
    else if (code <= 2) body = (isDay ? SMALL_SUN : SMALL_MOON) + CLOUD('#d6deeb', 4);
    else if (code === 3) body = CLOUD('#aeb9cc');
    else if (code === 45 || code === 48) body = '<g stroke="#aeb9cc" stroke-width="4" stroke-linecap="round"><path d="M12 24h40M8 34h48M14 44h36"/></g>';
    else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))
      body = CLOUD('#aeb9cc', -6) + '<g stroke="#5aa9ff" stroke-width="4" stroke-linecap="round"><path d="M22 50l-3 7M33 50l-3 7M44 50l-3 7"/></g>';
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86)
      body = CLOUD('#d6deeb', -6) + '<g fill="#ffffff"><circle cx="21" cy="53" r="3"/><circle cx="32" cy="57" r="3"/><circle cx="43" cy="53" r="3"/></g>';
    else if (code >= 95)
      body = CLOUD('#8c97ab', -6) + '<path d="M34 44l-8 11h7l-4 9 11-13h-7l4-7z" fill="#ffc94d"/>';
    else body = CLOUD('#aeb9cc');
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
  }

  const WX_TEXT = (c) => c === 0 ? 'Clear' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Cloudy' : c <= 48 ? 'Foggy'
    : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorms';

  return { esc, api, dayLabel, DAYS, weatherIcon, WX_TEXT };
})();
