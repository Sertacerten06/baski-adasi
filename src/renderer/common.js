// Ada ve panelin ortak yardımcıları
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtMin = (m, short) => {
    if (m == null || isNaN(m)) return '—';
    m = Math.max(0, Math.round(m));
    const h = Math.floor(m / 60); const mm = m % 60;
    if (short) return h ? `${h}s ${mm}dk` : `${mm}dk`;
    return h ? `${h} sa ${mm} dk` : `${mm} dk`;
  };
  const fmtEta = (m) => {
    if (m == null || isNaN(m)) return '—';
    const d = new Date(Date.now() + m * 60000);
    const t = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const days = Math.floor((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    return days === 0 ? t : days === 1 ? `yarın ${t}` : `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${t}`;
  };
  const fmtT = (v) => (v == null ? '—' : `${Math.round(v)}°`);
  const fmtSize = (b) => (b == null ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtDate = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
  };
  // "1012-1905-CHROMA(01)_PLA_0.2_6h57m18s.gcode.3mf" -> "CHROMA(01)_PLA_0.2_6h57m18s"
  const prettyFile = (f) => String(f || '').replace(/^.*\//, '').replace(/\.gcode(\.3mf)?$|\.3mf$|\.gco$|\.g$/i, '').replace(/^\d{4}-\d{4}-/, '');

  const STATUS = {
    printing: { text: 'Yazdırıyor', color: 'var(--c-print)' },
    paused: { text: 'Duraklatıldı', color: 'var(--c-pause)' },
    finished: { text: 'Bitti', color: 'var(--c-ok)' },
    error: { text: 'Hata', color: 'var(--c-err)' },
    idle: { text: 'Hazır', color: 'var(--c-idle)' },
    busy: { text: 'Meşgul', color: 'var(--c-busy)' },
    connecting: { text: 'Bağlanıyor', color: 'var(--c-busy)' },
    offline: { text: 'Çevrimdışı', color: 'var(--c-off)' },
  };
  const statusOf = (p) => {
    const s = STATUS[p.status] || STATUS.idle;
    return { ...s, text: p.statusText || s.text };
  };
  const heating = (p) => {
    const n = p.temps && p.temps.nozzle; const b = p.temps && p.temps.bed;
    return (n && n.target > 0) || (b && b.target > 0);
  };

  const I = (d, extra = '') => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICONS = {
    pause: I('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
    play: I('<path d="M7 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 7 5.5z"/>'),
    stop: I('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    bulb: I('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'),
    fan: I('<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7s3 4-1.5 6.5M14 12c4 0 7 1 7 4s-4 3-6.5-1.5M12 14c0 4-1 7-4 7s-3-4 1.5-6.5M10 12c-4 0-7-1-7-4s4-3 6.5 1.5"/>'),
    refresh: I('<path d="M20 11a8 8 0 0 0-14.9-3.9L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.9 3.9L20 15.5M20 20v-4.5h-4.5"/>'),
    upload: I('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>'),
    gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    alert: I('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
    nozzle: I('<path d="M8 3h8v5l-2 3v3h-4v-3L8 8z"/><path d="M12 17v4"/>'),
    bed: I('<rect x="3" y="14" width="18" height="4" rx="1"/><path d="M7 10c0-2 2-2 2-4M12 10c0-2 2-2 2-4M17 10c0-2 2-2 2-4"/>'),
    layers: I('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    flag: I('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    hourglass: I('<path d="M6 3h12M6 21h12M7 3v3a5 5 0 0 0 10 0V3M7 21v-3a5 5 0 0 1 10 0v3"/>'),
    trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    printer: I('<path d="M5 4h14v4H5zM7 8v8M17 8v8"/><path d="M4 20h16"/><path d="M10 16h4v-3h-4z"/>'),
    file: I('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    drop: I('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
    expand: I('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    up: I('<path d="m6 15 6-6 6 6"/>'),
    down: I('<path d="m6 9 6 6 6-6"/>'),
    wifi: I('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a15 15 0 0 1 20 0"/>'),
  };

  // dairesel ilerleme (SVG)
  const ring = (pct, size, stroke, color, track = 'var(--ring-track)') => {
    const r = (size - stroke) / 2; const C = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(100, pct || 0));
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg);display:block">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - p / 100)}" style="transition:stroke-dashoffset .6s cubic-bezier(.3,.7,.2,1)"/></svg>`;
  };

  window.U = { esc, fmtMin, fmtEta, fmtT, fmtSize, fmtDate, prettyFile, statusOf, heating, ICONS, ring, STATUS };
})();
