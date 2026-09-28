/* ไอคอนเส้น (stroke) ขนาด 24x24 วาดเป็น CSS mask จึงเปลี่ยนสีตาม token ได้
 * ใช้: ใส่ data-icon="ชื่อ" ที่ element แล้วเรียก Icons.hydrate() หรือสร้างด้วย Icons.plate(ชื่อ)
 */
(function () {
  const PATHS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
    sparkle: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    basket: '<path d="M4 9h16l-1.5 10a2 2 0 0 1-2 1.7h-9a2 2 0 0 1-2-1.7L4 9z"/><path d="M9 9l3-5 3 5"/><path d="M9.5 13v4M14.5 13v4"/>',
    wallet: '<path d="M6 6V5a2 2 0 0 1 2-2h9"/><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M16 13h2"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
    bowl: '<path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 7.5c0-1.5 1-2 1-3.5M12 7.5c0-1.5 1-2 1-3.5M16 7.5c0-1.5 1-2 1-3.5"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    egg: '<path d="M12 3c-3.6 0-6.5 5.6-6.5 10a6.5 6.5 0 0 0 13 0C18.5 8.6 15.6 3 12 3z"/>',
    meat: '<path d="M15 3.5a5.5 5.5 0 0 1 0 11c-1.1 0-2.1.5-2.9 1.3L9 18.9a2.2 2.2 0 1 1-3.1-3.1l3.1-3.1c.8-.8 1.3-1.8 1.3-2.9A5.5 5.5 0 0 1 15 3.5z"/>',
    fish: '<path d="M2 12c3-5 9.5-6.2 14-3l5-3v12l-5-3c-4.5 3.2-11 2-14-3z"/><path d="M7.5 11h.01"/>',
    leaf: '<path d="M5 19C5 10 11 4 20 4c0 9-6 15-15 15z"/><path d="M5 19l8-8"/>',
    fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M4 10h10"/><path d="M14 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
    drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    equal: '<path d="M5 9h14M5 15h14"/>',
    updown: '<path d="M8 20V4M8 4L4 8M8 4l4 4M16 4v16M16 20l-4-4M16 20l4-4"/>',
    coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 9.4a6 6 0 1 1-6.1 6.1"/>',
    scale: '<path d="M12 3v18M7 21h10M5 7h14"/><path d="M5 7l-3 7a3 3 0 0 0 6 0L5 7zM19 7l-3 7a3 3 0 0 0 6 0l-3-7z"/>',
    chart: '<path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5z"/><path d="M4 19a2 2 0 0 1 2-2h14"/>',
    arrowUp: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
    arrowDown: '<path d="M7 7l10 10"/><path d="M17 8v9H8"/>',
    arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  };

  const cacheUrl = {};
  function url(name) {
    if (!cacheUrl[name]) {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${PATHS[name] || PATHS.chart}</svg>`;
      cacheUrl[name] = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    }
    return cacheUrl[name];
  }
  function hydrate(root = document) {
    root.querySelectorAll("[data-icon]").forEach((node) => node.style.setProperty("--icon", url(node.dataset.icon)));
  }
  // วงกลมพื้นสีอ่อน + ไอคอนสีเข้มของโทนนั้น
  function plate(name, className = "icon-plate") {
    const node = document.createElement("span");
    node.className = className;
    node.dataset.icon = name;
    node.setAttribute("aria-hidden", "true");
    node.style.setProperty("--icon", url(name));
    return node;
  }
  window.Icons = { hydrate, plate, url };
})();
