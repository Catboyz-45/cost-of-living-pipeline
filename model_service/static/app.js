/* ตัวควบคุมหน้า dashboard: โหลดข้อมูลจาก API แล้ววาดด้วย charts.js
 * แต่ละหน้าโหลดครั้งแรกเมื่อถูกเปิด (lazy) และเก็บ cache ไว้ใช้ซ้ำ
 * ข้อความบนหน้าเขียนเป็นภาษาคนทั่วไป ศัพท์เทคนิคอยู่ในหน้า "เบื้องหลังระบบ"
 */
(function () {
  const { line, bars, map, sparkline, divergingLegend, cssVar, monthLabel } = window.Charts;
  const { plate, hydrate, url: iconUrl } = window.Icons;
  const $ = (id) => document.getElementById(id);
  const cache = {};

  // ---------- helpers ----------
  async function api(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || response.statusText);
    return data;
  }
  const once = (key, loader) => (cache[key] ??= loader());
  const parseDate = (text) => { const [y, m] = String(text).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, 1); };
  const thMonth = (text) => monthLabel(parseDate(text));
  const thDay = (text) => { const d = new Date(`${String(text).slice(0, 10)}T00:00:00`); return `${d.getDate()} ${monthLabel(d)}`; };
  const num = (v, digits = 2) => (v === null || v === undefined ? "–" : Number(v).toLocaleString("th-TH", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const pct = (v, digits = 2) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${num(v, digits)}%`);
  const compact = (v) => Number(v).toLocaleString("th-TH");
  const bahtPrice = (v) => (v === null || v === undefined ? "–" : `${num(v, v >= 1000 ? 0 : 2)} ฿`);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  // element ที่มีไอคอน (CSS วาดไอคอนจาก --icon)
  const withIcon = (node, name) => { node.style.setProperty("--icon", iconUrl(name)); return node; };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const reduceMotion = Charts.reduceMotion;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- อนิเมชัน (ปิดเองถ้าเครื่องตั้งค่าลดการเคลื่อนไหว) ----------
  // ตัวเลขนับจาก from ไปหา to เช่น 100.00 -> 102.53
  function countUp(node, to, { from = 0, format, duration = 1200 } = {}) {
    if (reduceMotion || document.hidden || !Number.isFinite(to)) { node.textContent = format(to); return; }
    const start = performance.now();
    let done = false;
    const step = (now) => {
      if (done) return;
      const t = Math.min(1, (now - start) / duration);
      node.textContent = format(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step); else done = true;
    };
    node.textContent = format(from);
    requestAnimationFrame(step);
    // กันกรณีเบราว์เซอร์พักอนิเมชัน (แท็บเบื้องหลัง): ครบเวลาแล้วต้องแสดงค่าจริงเสมอ
    setTimeout(() => { if (!done) { done = true; node.textContent = format(to); } }, duration + 100);
  }
  // ตัวเลขวิ่งสลับระหว่างรอ AI คิด แล้วคืนฟังก์ชันสำหรับหยุด
  function shuffleDigits(node) {
    const original = node.textContent;
    if (reduceMotion) return () => {};
    const timer = setInterval(() => {
      node.textContent = original.replace(/\d/g, () => String(Math.floor(Math.random() * 10)));
    }, 60);
    return () => { clearInterval(timer); node.textContent = original; };
  }
  // การ์ดและส่วนต่าง ๆ ค่อยเลื่อนขึ้นเมื่อเลื่อนจอมาถึง (ครั้งเดียว)
  const revealObserver = !reduceMotion && "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
      // ที่โผล่พร้อมกันค่อย ๆ ขึ้นทีละชิ้น แล้วล้าง delay ทิ้งเพื่อไม่ให้ hover หน่วง
      entries.filter((entry) => entry.isIntersecting).forEach((entry, i) => {
        const node = entry.target;
        if (i) {
          node.style.transitionDelay = `${Math.min(i, 6) * 70}ms`;
          setTimeout(() => { node.style.transitionDelay = ""; }, 700 + Math.min(i, 6) * 70);
        }
        node.classList.add("in");
        revealObserver.unobserve(node);
      });
    }, { rootMargin: "0px 0px -6% 0px" })
    : null;
  function prepareReveal() {
    // เปิดหน้าในแท็บเบื้องหลัง เบราว์เซอร์อาจไม่แจ้งการเลื่อนจอ จึงไม่ซ่อนอะไรเลยเพื่อให้เห็นเนื้อหาแน่นอน
    if (!revealObserver || document.hidden) return;
    document.querySelectorAll(".page > *:not(.block):not(.page-head), .block > *").forEach((node) => {
      node.classList.add("reveal");
      revealObserver.observe(node);
    });
  }
  // ป้าย AI: ไอคอน + ข้อความที่มีแสงวิ่งผ่าน
  function aiLabel(text) {
    const label = withIcon(el("div", "ai-label"), "sparkle");
    label.appendChild(el("span", "shine", text));
    return label;
  }
  const svgEl = (tag, attrs = {}, parent) => { const node = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (parent) parent.appendChild(node); return node; };
  const changeColor = (value) => (value > 0.05 ? cssVar("--bad") : value < -0.05 ? cssVar("--good") : cssVar("--ink-2"));
  // "แพงขึ้น 2.53%" / "ถูกลง 1.2%" / "ราคาเท่าเดิม"
  const moveText = (value, digits = 2) => (value === null || value === undefined ? "–"
    : Math.abs(value) < 0.005 ? "ราคาเท่าเดิม" : `${value > 0 ? "แพงขึ้น" : "ถูกลง"} ${num(Math.abs(value), digits)}%`);

  function deltaNode(diff, unit, upIsBad = true) {
    const node = el("span", "delta");
    if (diff === null || diff === undefined || !Number.isFinite(diff)) { node.classList.add("flat"); node.textContent = "–"; return node; }
    const direction = Math.abs(diff) < 0.005 ? "flat" : diff > 0 ? "up" : "down";
    node.classList.add(direction === "flat" ? "flat" : (direction === "up") === upIsBad ? "up" : "down");
    node.textContent = `${direction === "up" ? "▲" : direction === "down" ? "▼" : "●"} ${diff > 0 ? "+" : ""}${num(diff, 2)}${unit}`;
    return node;
  }
  // การ์ดตัวเลข: icon = ชื่อไอคอน, tone = โทนสีพื้นอ่อน (blue/orange/green/purple/teal/amber/pink)
  function tile(container, { label, value, delta, sub, spark, icon, tone }) {
    const box = el("div", "tile" + (tone ? ` tone-${tone}` : ""));
    const head = el("div", "tile-head");
    if (icon) head.appendChild(plate(icon));
    head.appendChild(el("div", "label", label));
    box.append(head, el("div", "value", value));
    if (delta) box.appendChild(delta);
    const holder = spark ? el("div", "spark") : null;
    if (holder) box.appendChild(holder);
    if (sub) box.appendChild(el("div", "sub", sub));
    container.appendChild(box);
    if (holder) spark(holder);
    return box;
  }
  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map((option) => {
      const node = el("option", "", option.label);
      node.value = option.value;
      return node;
    }));
    if (value !== undefined) select.value = value;
  }
  // ---------- ตัวเลือกที่เข้าธีม ----------
  // รายการของ <select> ตอนเปิดวาดโดยระบบ (macOS/Windows) แต่งสีไม่ได้ จึงซ่อน <select> ไว้เก็บค่า
  // แล้วแสดงเป็นปุ่มหรือรายการที่วาดเอง โค้ดเดิมยังอ่าน/ตั้ง select.value และฟัง "change" ได้เหมือนเดิม
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  function watchSelect(select, sync) {
    Object.defineProperty(select, "value", {
      configurable: true,
      get() { return nativeValue.get.call(this); },
      set(v) { nativeValue.set.call(this, v); sync(); },
    });
    new MutationObserver(sync).observe(select, { childList: true });
  }
  const pick = (select, value) => { select.value = value; select.dispatchEvent(new Event("change")); };

  // ตัวเลือกไม่กี่อย่าง: แสดงเป็นปุ่มเรียงกัน
  function chipSelect(select) {
    const group = el("div", "chips chips-wrap");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", select.getAttribute("aria-label") || "");
    select.hidden = true;
    select.after(group);
    const sync = () => group.replaceChildren(...[...select.options].map((option) => {
      const on = option.value === select.value;
      const button = el("button", on ? "active" : "", option.textContent.trim());
      button.type = "button";
      button.dataset.value = option.value;
      button.setAttribute("aria-pressed", String(on));
      return button;
    }));
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (button && button.dataset.value !== select.value) pick(select, button.dataset.value);
    });
    watchSelect(select, sync);
    sync();
  }

  // ตัวเลือกยาว (สินค้า, จังหวัด): ปุ่มที่เปิดรายการพร้อมช่องค้นหา
  function picker(select, { searchPlaceholder = "ค้นหา" } = {}) {
    select.hidden = true;
    const wrap = el("div", "picker");
    const button = withIcon(el("button", "picker-button"), "chevron");
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const labelledBy = select.getAttribute("aria-labelledby");
    const text = el("span", "picker-text");
    if (labelledBy) { text.id = `${select.id}-value`; button.setAttribute("aria-labelledby", `${labelledBy} ${text.id}`); }
    button.appendChild(text);
    const panel = el("div", "picker-panel");
    panel.hidden = true;
    const search = el("input", "picker-search");
    search.type = "search";
    search.placeholder = searchPlaceholder;
    search.setAttribute("aria-label", searchPlaceholder);
    const list = el("div", "picker-list");
    list.setAttribute("role", "listbox");
    panel.append(search, list);
    wrap.append(button, panel);
    select.after(wrap);

    const render = () => {
      const query = search.value.trim();
      const options = [...select.options].filter((o) => o.value !== "" && (!query || o.textContent.includes(query)));
      list.replaceChildren(...options.map((option) => {
        const on = option.value === select.value;
        const item = el("button", `picker-option${on ? " selected" : ""}`, option.textContent.trim());
        item.type = "button";
        item.dataset.value = option.value;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(on));
        return item;
      }));
      if (!options.length) list.appendChild(el("div", "picker-empty", "ไม่พบที่ค้นหา"));
    };
    const sync = () => {
      text.textContent = select.selectedOptions[0]?.textContent.trim() || "–";
      if (!panel.hidden) render();
    };
    const open = () => {
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      search.value = "";
      search.hidden = select.options.length <= 8;
      render();
      (search.hidden ? list.querySelector(".selected") || list.firstChild : search).focus();
      list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    };
    const close = (refocus) => {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (refocus) button.focus();
    };
    const choose = (value) => { close(true); if (value !== select.value) pick(select, value); };
    button.addEventListener("click", () => (panel.hidden ? open() : close()));
    search.addEventListener("input", render);
    list.addEventListener("click", (event) => { const item = event.target.closest("[data-value]"); if (item) choose(item.dataset.value); });
    panel.addEventListener("keydown", (event) => {
      const items = [...list.querySelectorAll("[data-value]")];
      const index = items.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      else if (event.key === "ArrowDown") { event.preventDefault(); items[Math.min(items.length - 1, index + 1)]?.focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); if (index <= 0 && !search.hidden) search.focus(); else items[Math.max(0, index - 1)]?.focus(); }
      else if (event.key === "Enter" && document.activeElement === search && items.length) { event.preventDefault(); choose(items[0].dataset.value); }
    });
    document.addEventListener("pointerdown", (event) => { if (!wrap.contains(event.target)) close(); });
    wrap.addEventListener("focusout", (event) => { if (event.relatedTarget && !wrap.contains(event.relatedTarget)) close(); });
    watchSelect(select, sync);
    sync();
  }

  function tableRows(table, headers, rows, onClick) {
    table.replaceChildren();
    const head = el("tr");
    for (const header of headers) { const th = el("th", header.num ? "num" : "", header.label); head.appendChild(th); }
    const thead = el("thead"); thead.appendChild(head); table.appendChild(thead);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr", onClick ? "clickable" : "");
      for (const [index, cell] of row.cells.entries()) {
        const td = el("td", headers[index].num ? "num" : "");
        if (cell instanceof Node) td.appendChild(cell); else td.textContent = cell;
        tr.appendChild(td);
      }
      if (onClick) tr.addEventListener("click", () => onClick(row));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }
  const showError = (container, error) => { container.replaceChildren(el("div", "empty-state", `โหลดข้อมูลไม่สำเร็จ: ${error.message}`)); };
  function moneyLine(before, from, middle, to) {
    const node = el("div", "money-line");
    node.append(document.createTextNode(before), el("b", "", from), document.createTextNode(middle), el("b", "", to));
    return node;
  }

  // ---------- ชื่อหมวดแบบภาษาคน (ชื่อทางการของ สนค. ยาวและเข้าใจยาก) ----------
  const PLAIN_NAMES = {
    "00000": "ของทุกอย่างรวมกัน", "10000": "อาหารและเครื่องดื่ม", "11000": "ของสดทำกินเองที่บ้าน", "12000": "อาหารสำเร็จรูป / ซื้อกิน",
    "20000": "เสื้อผ้าและรองเท้า", "21000": "เสื้อผ้า", "22000": "รองเท้า",
    "30000": "บ้านและของใช้ในบ้าน", "31000": "ค่าเช่าบ้าน / ที่พัก", "32000": "ค่าไฟ ค่าน้ำ ค่าแก๊ส", "33000": "ผ้าปูที่นอน ผ้าม่าน",
    "34000": "ของใช้ในบ้าน", "35000": "เฟอร์นิเจอร์และเครื่องใช้ไฟฟ้า", "36000": "ของทำความสะอาด", "37000": "ค่าจ้างแม่บ้าน / คนงาน",
    "40000": "สุขภาพและของใช้ส่วนตัว", "41000": "ค่ารักษาและค่ายา", "42000": "ของใช้ส่วนตัว", "43000": "ประกันสุขภาพ / ประกันชีวิต",
    "50000": "เดินทางและสื่อสาร", "51000": "ค่ารถโดยสาร", "52000": "รถและน้ำมันรถ", "53000": "ภาษีและประกันรถ", "54000": "ค่าโทรศัพท์ / อินเทอร์เน็ต",
    "60000": "บันเทิง การศึกษา ศาสนา", "61000": "เที่ยว บันเทิง หนังสือ", "62000": "การศึกษา", "63000": "ทำบุญ / ศาสนา",
    "70000": "บุหรี่และเหล้า", "71000": "บุหรี่", "72000": "เหล้า เบียร์",
    "91000": "อาหารสด", "92000": "พลังงาน (น้ำมัน ไฟ แก๊ส)",
  };
  const plainName = (code, name) => PLAIN_NAMES[code] || name;
  // เลือกเฉพาะหมวดที่เป็นค่าใช้จ่ายจริง (ตัดกลุ่มสำหรับนักวิเคราะห์ เช่น "ไม่รวมอาหารสด")
  const isEverydayCategory = (code) => code < "80000" || code === "91000" || code === "92000";

  const areasP = () => once("areas", () => api("/api/areas"));
  const commoditiesP = () => once("commodities", () => api("/api/commodities?max_level=3"));
  const summaryP = () => once("summary", () => api("/api/dashboard/summary"));
  const pricesP = () => once("prices", () => api("/api/prices"));
  const metricsP = () => once("metrics", () => api("/api/model/metrics"));
  const areaOptions = (list) => list.map((a) => ({ value: a.area_key, label: a.area_type === "region" ? `◆ ${a.area_name}` : a.area_name }));

  // ---------- ปุ่ม i อธิบายคำศัพท์ (ชี้หรือกดเพื่อดู) ----------
  function showInfo(button) {
    const box = $("tooltip");
    box.replaceChildren(el("div", "t-text", button.dataset.tip));
    box.hidden = false;
    const rect = button.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const left = Math.min(window.innerWidth - boxRect.width - 8, Math.max(8, rect.left + rect.width / 2 - boxRect.width / 2));
    const top = rect.bottom + 8 + boxRect.height > window.innerHeight ? rect.top - boxRect.height - 8 : rect.bottom + 8;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(8, top)}px`;
  }
  const hideInfo = () => { $("tooltip").hidden = true; };
  document.addEventListener("pointerover", (event) => { const button = event.target.closest(".info"); if (button) showInfo(button); });
  document.addEventListener("pointerout", (event) => { if (event.target.closest(".info")) hideInfo(); });
  document.addEventListener("focusin", (event) => { const button = event.target.closest(".info"); if (button) showInfo(button); });
  document.addEventListener("focusout", (event) => { if (event.target.closest(".info")) hideInfo(); });
  document.addEventListener("click", (event) => { const button = event.target.closest(".info"); if (button) { event.stopPropagation(); showInfo(button); } });

  // ---------- ราคาของกิน (ราคาจริงจากกรมการค้าภายใน) ----------
  // สินค้าพื้นฐานที่แสดงก่อน: ไข่ไก่เบอร์ 3, หมูเนื้อแดง, ข้าวหอม, คะน้า, ปลาทู, น้ำมันปาล์ม
  const STAPLES = ["P11028", "P11003", "R13001", "P13001", "P12014", "P16011"];
  const GROUP_LABELS = { "ราคาขายปลีกข้าวสาร": "ข้าวสาร", "พืชน้ำมันและน้ำมันพืช": "น้ำมันพืช", "น้ำมันเชื้อเพลิง": "น้ำมันรถ" };
  // ค่าแรง 1 วันซื้ออะไรได้: ของกินพื้นฐาน + น้ำมันแก๊สโซฮอล์ 95
  const BUY_ITEMS = [...STAPLES, "F52002"];
  const PAGE_SIZE = 24;
  let selectedProduct = null;
  let priceGroup = "";
  // หน้าแรกเริ่มที่ของกินพื้นฐาน 6 อย่าง กด "ดูสินค้าอื่น" หรือค้นหาแล้วค่อยแสดงเพิ่ม
  let priceLimit = STAPLES.length;
  const perUnit = (unit) => (unit || "").replace(/^บาท/, "");
  const yoyPct = (p) => (p.price_1y_ago ? (p.latest_price / p.price_1y_ago - 1) * 100 : null);

  // เลือกไอคอนและโทนสีของการ์ดสินค้าจากชื่อสินค้า
  function productLook(label) {
    if (/ดีเซล|แก๊สโซฮอล์|เบนซิน/.test(label)) return { icon: "fuel", tone: "blue" };
    if (/ไข่/.test(label)) return { icon: "egg", tone: "amber" };
    if (/ปลา|กุ้ง|หมึก|หอย/.test(label)) return { icon: "fish", tone: "teal" };
    if (/สุกร|หมู|ไก่|เนื้อ|เป็ด|กระบือ/.test(label)) return { icon: "meat", tone: "pink" };
    if (/น้ำมัน/.test(label)) return { icon: "drop", tone: "amber" };
    if (/ข้าว/.test(label)) return { icon: "bowl", tone: "orange" };
    if (/ส้ม|กล้วย|มะม่วง|มะละกอ|แตงโม|ฝรั่ง|เงาะ|มังคุด|ทุเรียน|ลองกอง|ลิ้นจี่|ลำไย|องุ่น|สับปะรด|น้อยหน่า|มะพร้าว/.test(label)) return { icon: "basket", tone: "purple" };
    return { icon: "leaf", tone: "green" };
  }

  // รูปสินค้าจริงจาก Wikimedia Commons (เครดิตใน static/products/credits.html) จับชนิดจากชื่อสินค้า ตัวแรกที่ตรงชนะ
  // สินค้าต่างเกรด/ต่างร้านใช้รูปเดียวกัน · ผักกะเฉดไม่มีรูปถ่ายที่ใช้ได้ จึงเป็นภาพวาด SVG ที่ทำขึ้นเอง
  const PRODUCT_PHOTOS = [
    ["fuel", /ดีเซล|แก๊สโซฮอล์/], ["salted-egg", /ไข่เป็ดเค็ม/], ["duck-egg", /ไข่เป็ด/], ["egg", /ไข่ไก่/],
    ["pork-belly", /หมูสามชั้น/], ["pork", /สุกร|หมู/], ["beef", /เนื้อโค/], ["chicken-feet", /แข้ง ขา ตีน/],
    ["chicken-wing", /ไก่.*ปีก/], ["chicken-leg", /ไก่.*(น่อง|สะโพก)/], ["chicken-breast", /อกไก่|ไก่.*(เนื้ออก|สันใน)/], ["chicken", /ไก่/], ["duck", /เป็ดสด/],
    ["giant-prawn", /กุ้งก้ามกราม/], ["shrimp", /กุ้ง/], ["seabass", /ปลากระพง/], ["snakehead", /ปลาช่อน/], ["catfish", /ปลาดุก/],
    ["tilapia", /ปลานิล|ปลาทับทิม/], ["mackerel", /ปลาทู/], ["pangasius", /ปลาสวาย/], ["cuttlefish", /หมึกกระดอง/], ["squid", /หมึก/],
    ["clam", /หอยลาย/], ["cockle", /หอยแครง/], ["mussel", /หอยแมลงภู่/], ["krachai", /กระชาย/], ["cauliflower", /กะหล่ำดอก/],
    ["cabbage", /กะหล่ำปลี/], ["ginger", /ขิง/], ["celery", /ขึ้นฉ่าย/], ["baby-corn", /ข้าวโพดฝักอ่อน/], ["scallion", /ต้นหอม/],
    ["long-bean", /ถั่วฝักยาว/], ["choy-sum", /กวางตุ้ง/], ["water-mimosa", /กะเฉด/, "svg"], ["napa", /ผักกาดขาว/], ["lettuce", /ผักกาดหอม/], ["kale", /คะน้า/],
    ["coriander", /ผักชี/], ["water-spinach", /ผักบุ้ง/], ["dried-chili", /พริกแห้ง/], ["pepper", /พริกไทย/], ["chili", /พริก/],
    ["wax-gourd", /ฟักเขียว/], ["lime", /มะนาว/], ["bitter-melon", /มะระ/], ["papaya", /มะละกอ/], ["eggplant", /มะเขือเจ้าพระยา|มะเขือยาว/],
    ["tomato", /มะเขือเทศ/], ["asparagus", /หน่อไม้ฝรั่ง/], ["radish", /หัวผักกาด/], ["cucumber", /แตงกวา/], ["banana", /กล้วย/],
    ["durian", /ทุเรียน/], ["guava", /^ฝรั่ง/], ["mango", /มะม่วง/], ["mangosteen", /มังคุด/], ["longkong", /ลองกอง/], ["longan", /ลำไย/],
    ["lychee", /ลิ้นจี่/], ["pineapple", /สับปะรด/], ["tangerine", /ส้มเขียวหวาน/], ["pomelo", /ส้มโอ/], ["rambutan", /เงาะ/],
    ["watermelon", /แตงโม/], ["roselle", /กระเจี๊ยบ/], ["garlic", /กระเทียม/], ["tamarind", /มะขาม/], ["potato", /มันฝรั่ง/],
    ["jobs-tears", /ลูกเดือย/], ["onion", /หอมหัวใหญ่/], ["shallot", /หอมแดง/], ["sesame", /^งา/], ["cooking-oil", /น้ำมัน/],
    ["peanut", /ถั่วลิสง/], ["grated-coconut", /มะพร้าวขาวขูด/], ["coconut", /มะพร้าว/], ["sticky-rice", /ข้าวสารเหนียว/], ["rice", /ข้าวสาร|ข้าวหอม/],
  ];
  const productPhoto = (label) => {
    const hit = PRODUCT_PHOTOS.find(([, pattern]) => pattern.test(label));
    return hit ? `/static/products/${hit[0]}.${hit[2] || "jpg"}` : null;
  };
  const photoImg = (src, className) => {
    const img = el("img", className);
    img.src = src; img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    return img;
  };

  function priceCard(container, product) {
    const look = productLook(product.label);
    const card = el("button", "price-card");
    card.type = "button";
    card.dataset.product = product.product_id;
    const head = el("div", "price-head");
    const title = el("div");
    title.append(el("div", "name", product.label), el("div", "unit", GROUP_LABELS[product.product_group] || product.product_group || ""));
    head.append(plate(look.icon), title);
    const priceRow = el("div", "price-row");
    priceRow.append(el("span", "price", bahtPrice(product.latest_price)), el("span", "per", perUnit(product.unit)));
    const yoy = yoyPct(product);
    card.append(head, priceRow, yoy === null ? el("span", "delta flat", "ยังไม่มีราคาปีก่อน") : deltaNode(yoy, "% จากปีก่อน"));
    const spark = el("div", "spark");
    card.append(spark, el("div", "muted", `12 เดือนล่าสุด · ราคาวันที่ ${thDay(product.price_date)}`));
    card.addEventListener("click", () => {
      selectedProduct = product;
      showPriceDetail();
    });
    const item = el("div", "price-item");
    const add = el("button", "add-basket");
    add.type = "button";
    add.dataset.product = product.product_id;
    add.addEventListener("click", () => {
      if (inBasket(product.product_id)) { location.hash = "basket"; return; }
      addToBasket(product);
    });
    item.append(card, add);
    container.appendChild(item);
    syncAddButtons();
    // เส้นเล็ก 12 เดือน: สีตามทิศทางจากปีก่อน (ส้ม = แพงขึ้น, น้ำเงิน = ถูกลง)
    const sparkColor = yoy === null || Math.abs(yoy) < 0.05 ? cssVar("--muted") : yoy > 0 ? cssVar("--up") : cssVar("--down");
    if (product.spark && product.spark.length > 1) sparkline(spark, product.spark.slice(-12), { height: 44, color: sparkColor });
  }

  async function renderPriceExplorer() {
    const products = await pricesP();
    const chips = $("price-groups");
    if (!chips.children.length) {
      const groups = [...new Set(products.map((p) => p.product_group).filter(Boolean))];
      for (const [value, label] of [["", "ทั้งหมด"], ...groups.map((g) => [g, GROUP_LABELS[g] || g])]) {
        const button = el("button", value === priceGroup ? "active" : "", label);
        button.dataset.group = value;
        chips.appendChild(button);
      }
      chips.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-group]");
        if (!button) return;
        priceGroup = button.dataset.group;
        priceLimit = PAGE_SIZE;
        chips.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === button));
        drawPriceGrid(products);
      });
      $("price-search").addEventListener("input", () => { priceLimit = PAGE_SIZE; drawPriceGrid(products); });
      $("price-more").addEventListener("click", () => { priceLimit = priceLimit < PAGE_SIZE ? PAGE_SIZE : priceLimit + PAGE_SIZE; drawPriceGrid(products); });
    }
    drawPriceGrid(products);
    if (!selectedProduct) selectedProduct = products.find((p) => p.product_id === STAPLES[0]) || products[0] || null;
    if (!$("price-detail").hidden) await drawPrice();
    return products;
  }

  // กราฟราคาย้อนหลังแสดงเมื่อกดการ์ดสินค้า (หน้าแรกจะได้ไม่ยาวเกิน)
  async function showPriceDetail() {
    $("price-detail").hidden = false;
    await drawPrice();
    $("price-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function drawPriceGrid(products) {
    const query = $("price-search").value.trim();
    const rank = (p) => { const index = STAPLES.indexOf(p.product_id); return index === -1 ? STAPLES.length : index; };
    const matched = products
      .filter((p) => (!priceGroup || p.product_group === priceGroup) && (!query || p.label.includes(query)))
      .sort((a, b) => rank(a) - rank(b) || a.product_id.localeCompare(b.product_id));
    const grid = $("price-grid");
    grid.replaceChildren();
    if (!products.length) grid.appendChild(el("div", "empty-state", "ยังไม่มีราคาจริง: รัน DAG เพื่อ scrape ราคาจากกรมการค้าภายใน"));
    else if (!matched.length) grid.appendChild(el("div", "empty-state", "ไม่พบสินค้าที่ค้นหา"));
    for (const product of matched.slice(0, priceLimit)) priceCard(grid, product);
    const latest = products.reduce((max, p) => (p.price_date > max ? p.price_date : max), "");
    $("price-count").textContent = products.length ? `${compact(products.length)} รายการ · สำรวจล่าสุด ${thDay(latest)}` : "";
    $("price-more").hidden = matched.length <= priceLimit;
    $("price-more").textContent = priceLimit < PAGE_SIZE ? `ดูสินค้าอื่น (ทั้งหมด ${compact(matched.length)} รายการ)` : "แสดงเพิ่ม";
    // ปุ่มกลุ่มสินค้าแสดงเมื่อเริ่มดูสินค้าอื่นหรือค้นหาแล้ว
    $("price-groups").hidden = priceLimit < PAGE_SIZE && !query && !priceGroup;
    document.querySelectorAll(".price-card").forEach((card) => card.classList.toggle("active", card.dataset.product === selectedProduct?.product_id));
  }

  async function drawPrice() {
    const container = $("chart-price");
    const badge = $("price-badge");
    document.querySelectorAll(".price-card").forEach((card) => card.classList.toggle("active", card.dataset.product === selectedProduct?.product_id));
    if (!selectedProduct) { container.replaceChildren(el("div", "empty-state", "ยังไม่มีราคาสินค้า")); badge.replaceChildren(); return; }
    const product = selectedProduct;
    $("price-title").textContent = `${product.label} (${product.unit})`;
    badge.replaceChildren(el("div", "muted", `ราคาจริง ${thDay(product.price_date)}`), el("div", "big", bahtPrice(product.latest_price)));
    if (product.next_month_price) {
      const next = el("div", "badge-change", `เดือนหน้าคาดว่า ≈ ${bahtPrice(product.next_month_price)}`);
      next.style.color = changeColor(product.predicted_change_pct);
      badge.appendChild(next);
    }
    try {
      const data = await api(`/api/prices/history?product_id=${product.product_id}`);
      const color = cssVar("--actual");
      line(container, {
        yFormat: (v, isAxis) => (isAxis ? num(v, Math.abs(v) < 10 ? 2 : v < 100 ? 1 : 0) : bahtPrice(v)),
        endLabels: false, forceLegend: true, ariaLabel: "ราคาจริงย้อนหลัง",
        series: [{ name: "ราคาเฉลี่ยของเดือน", color, area: true, points: data.monthly.map((m) => [parseDate(m.period_date), m.avg_price]) }],
        band: { name: "ถูกสุด–แพงสุดของเดือน", color, points: data.monthly.map((m) => [parseDate(m.period_date), m.low_price, m.high_price]) },
      });
    } catch (error) { showError(container, error); }
  }

  // ---------- หน้า 1: ของแพงขึ้นแค่ไหน ----------
  const LONGRUN_CODES = ["00000", "10000", "92000", "62000"];
  const LONGRUN_SHORT = { "00000": "รวม", "10000": "อาหาร", "92000": "พลังงาน", "62000": "การศึกษา" };
  const SERIES_COLORS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];
  let longrunYears = 10;

  async function renderOverview() {
    const summary = await summaryP();
    const latest = summary.latest_period;
    const headline = summary.trend["00000"], food = summary.trend["10000"], energy = summary.trend["92000"];
    const last = (list) => list[list.length - 1] || {};
    const inflation = last(headline).yoy;

    document.querySelectorAll("[data-latest]").forEach((node) => { node.textContent = thMonth(latest); });
    // พาดหัว: ของที่ปีก่อนจ่าย 100 บาท วันนี้ต้องจ่าย 102.53 บาท
    const hero = $("hero");
    const numSpan = (text, cls = "") => el("span", `num ${cls}`.trim(), text);
    const heroLine = (...parts) => { const span = el("span", "line"); span.append(...parts); return span; };
    hero.replaceChildren(
      heroLine(document.createTextNode("ของที่ปีก่อนจ่าย "), numSpan("100"), document.createTextNode(" บาท")), el("br"),
      heroLine(document.createTextNode("วันนี้ต้องจ่าย "), numSpan("100.00", inflation > 0 ? "up" : inflation < 0 ? "down" : ""), document.createTextNode(" บาท")),
    );
    countUp(hero.querySelector(".num.up, .num.down") || hero.querySelectorAll(".num")[1], 100 + inflation, { from: 100, format: (v) => num(v, 2), duration: 1600 });
    yoyBars($("chart-yoy"), headline.slice(-12));

    const tiles = $("overview-tiles");
    tiles.replaceChildren();
    const foodTile = tile(tiles, { label: "ค่าอาหารและเครื่องดื่ม", value: pct(0), sub: "จากปีก่อน", icon: "bowl" });
    countUp(foodTile.querySelector(".value"), last(food).yoy, { format: (v) => pct(v) });
    const energyTile = tile(tiles, { label: "ค่าน้ำมัน ไฟ แก๊ส", value: pct(0), sub: "จากปีก่อน", icon: "bolt" });
    countUp(energyTile.querySelector(".value"), last(energy).yoy, { format: (v) => pct(v) });
    const fuelTile = tile(tiles, { label: "แก๊สโซฮอล์ 95 วันนี้", value: "–", sub: "ราคาหน้าปั๊ม กรุงเทพฯ", icon: "fuel" });
    const wage = summary.bangkok_wage;
    const wageTile = tile(tiles, { label: "ค่าแรงขั้นต่ำ กทม.", value: "–", sub: "ค่าแรง 1 วัน", icon: "wallet" });
    if (wage) countUp(wageTile.querySelector(".value"), wage.latest.nominal_wage, { format: (v) => `${num(v, 0)} ฿/วัน` });
    $("freshness").textContent = `ข้อมูลถึง ${thMonth(latest)}`;

    const [products, categories] = await Promise.all([
      renderPriceExplorer(),
      once("cat2", () => api("/api/categories/yoy?level=2")),
    ]);
    const egg = products.find((p) => p.product_id === "P11028");
    if (wage && egg) wageTile.querySelector(".sub").textContent = `ซื้อไข่ได้วันละ ${num(wage.latest.nominal_wage / egg.latest_price, 0)} ฟอง`;
    const fuel = products.find((p) => p.product_id === "F52002");
    if (fuel) {
      countUp(fuelTile.querySelector(".value"), fuel.latest_price, { format: (v) => `${bahtPrice(v)}/ลิตร` });
      const yoy = yoyPct(fuel);
      if (yoy !== null) fuelTile.querySelector(".sub").replaceWith(deltaNode(yoy, "% จากปีก่อน"));
    }
    renderAiBanner(summary.forecast["00000"], products);
    renderDishes();

    // หมวดค่าใช้จ่ายจริงเท่านั้น (ตัดกลุ่มสำหรับนักวิเคราะห์) เรียงจากแพงขึ้นมากสุด
    const everyday = categories.items.filter((item) => isEverydayCategory(item.commodity_code) && item.change_yoy !== null)
      .sort((a, b) => b.change_yoy - a.change_yoy);
    const shown = [...everyday.filter((i) => i.change_yoy > 0).slice(0, 5), ...everyday.filter((i) => i.change_yoy < 0).slice(-3)];
    $("category-sub").textContent = `5 เรื่องที่แพงขึ้นมากสุด และ 3 เรื่องที่ถูกลงมากสุด · ${categories.period ? thMonth(categories.period) : ""} เทียบกับปีก่อน`;
    bars($("chart-categories"), shown.map((item) => ({
      label: plainName(item.commodity_code, item.commodity_name),
      value: item.change_yoy,
      color: cssVar(item.change_yoy > 0 ? "--up" : "--down"),
      extra: [{ label: "จากเดือนก่อน", value: pct(item.change_mom) }],
    })), { format: (v) => pct(v), valueLabel: "จากปีก่อน" });

    // ประโยคสรุปบนสุดของหน้า
    const staples = STAPLES.map((id) => products.find((p) => p.product_id === id)).filter((p) => p && yoyPct(p) !== null);
    const sortedStaples = [...staples].sort((a, b) => yoyPct(b) - yoyPct(a));
    const lede = $("overview-takeaway");
    lede.replaceChildren(document.createTextNode(`${moveText(inflation)} จากปีก่อน`));
    if (sortedStaples.length) {
      const up = sortedStaples[0], down = sortedStaples[sortedStaples.length - 1];
      lede.append(document.createTextNode(" ของกินพื้นฐานที่ขึ้นแรงสุดคือ"), el("b", "", `${up.label} (${pct(yoyPct(up), 0)})`));
      if (yoyPct(down) < 0) lede.append(document.createTextNode(" ส่วน"), el("b", "", `${down.label}ถูกลง (${pct(yoyPct(down), 0)})`));
    }
  }

  // แท่งเงินเฟ้อรายเดือน: ขึ้น = ส้ม ลง = น้ำเงิน เดือนล่าสุดเข้มสุด ชี้เพื่อดูตัวเลข
  function yoyBars(container, points) {
    container.replaceChildren();
    const values = points.map((p) => p.yoy).filter(Number.isFinite);
    if (!values.length) return;
    const width = 560, height = 96, gap = 4, n = points.length, plot = height - 20;
    const lo = Math.min(0, ...values), hi = Math.max(0, ...values), span = hi - lo || 1;
    const bw = (width - gap * (n - 1)) / n;
    const zero = (hi / span) * plot;
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `เงินเฟ้อ ${n} เดือนล่าสุด` }, container);
    points.forEach((p, i) => {
      const x = i * (bw + gap), v = p.yoy;
      const h = Math.max(1.5, (Math.abs(v) / span) * plot);
      const bar = svgEl("rect", { x, y: v >= 0 ? zero - h : zero, width: bw, height: h, rx: 3, fill: cssVar(v >= 0 ? "--up" : "--down"), opacity: i === n - 1 ? 1 : 0.55, class: `yoy-bar ${v >= 0 ? "pos" : "neg"}` }, svg);
      bar.style.animationDelay = `${i * 45}ms`;
      const hit = svgEl("rect", { x, y: 0, width: bw + gap, height: plot, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (event) => Charts.showTooltip(event, thMonth(p.period), [{ label: "จากปีก่อน", value: pct(v), color: cssVar(v >= 0 ? "--up" : "--down") }]));
      hit.addEventListener("pointerleave", Charts.hideTooltip);
    });
    svgEl("line", { x1: 0, x2: width, y1: zero, y2: zero, stroke: cssVar("--muted"), "stroke-width": 1 }, svg);
    for (const [i, anchor] of [[0, "start"], [n - 1, "end"]]) {
      const label = svgEl("text", { x: anchor === "start" ? 0 : width, y: height - 3, "text-anchor": anchor, class: "axis-text" }, svg);
      label.textContent = thMonth(points[i].period);
    }
  }

  async function renderLongrun() {
    const container = $("chart-longrun");
    try {
      const data = await once("longrun", () => api(`/api/national/series?codes=${LONGRUN_CODES.join(",")}`));
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - longrunYears);
      line(container, {
        ariaLabel: "ระดับราคาย้อนหลังหลายปี",
        yFormat: (v) => num(v, 1),
        series: data.series.map((s, i) => ({
          name: plainName(s.code, s.name),
          short: LONGRUN_SHORT[s.code] || s.name,
          color: cssVar(SERIES_COLORS[i]),
          area: i === 0, areaOpacity: 0.12,
          points: s.points.map((p) => [parseDate(p[0]), p[1]]).filter((p) => p[0] >= cutoff),
        })),
      });
    } catch (error) { showError(container, error); }
  }

  // ---------- ต้นทุนวัตถุดิบข้าว 1 จาน ----------
  let dishId = "kaprao";
  async function renderDishes() {
    try {
      const list = await once("dishes", () => api("/api/dishes"));
      if (!list.length) { $("dish-receipt").replaceChildren(el("div", "empty-state", "ยังไม่มีราคาวัตถุดิบครบ")); return; }
      const chips = $("dish-chips");
      if (!chips.children.length) {
        for (const dish of list) {
          const button = el("button", "", dish.name);
          button.dataset.dish = dish.id;
          chips.appendChild(button);
        }
        chips.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-dish]");
          if (!button) return;
          dishId = button.dataset.dish;
          drawDish(list);
        });
      }
      drawDish(list);
    } catch (error) { showError($("dish-receipt"), error); }
  }

  function drawDish(list) {
    const dish = list.find((d) => d.id === dishId) || list[0];
    document.querySelectorAll("#dish-chips button").forEach((b) => b.classList.toggle("active", b.dataset.dish === dish.id));
    // ใบเสร็จวัตถุดิบ
    const receipt = $("dish-receipt");
    receipt.replaceChildren(el("div", "receipt-kicker", "ใบเสร็จวัตถุดิบ"), el("div", "receipt-title", dish.name), el("div", "receipt-rule"));
    for (const item of dish.ingredients) {
      const row = el("div", "receipt-row");
      row.append(el("span", "", item.text), el("span", "receipt-cost", num(item.cost, 2)));
      receipt.appendChild(row);
    }
    const total = el("div", "receipt-row receipt-total");
    total.append(el("span", "", "รวม 1 จาน"), el("span", "receipt-cost", bahtPrice(dish.cost_now)));
    receipt.append(el("div", "receipt-rule"), total, el("div", "receipt-note", `ราคา ${thDay(dish.price_date)} · ไม่รวมเครื่องปรุง ค่าแก๊ส`));

    // ประโยคเทียบกับอดีตที่ไกลที่สุดที่มีข้อมูล
    const [baseLabel, base] = [["10 ปีก่อน", dish.cost_10y_ago], ["5 ปีก่อน", dish.cost_5y_ago], ["ปีก่อน", dish.cost_1y_ago]].find(([, v]) => v) || [];
    const headline = $("dish-sub");
    headline.replaceChildren();
    if (base) {
      const change = (dish.cost_now / base - 1) * 100;
      headline.append(
        el("b", "", `${change >= 0 ? "แพงกว่า" : "ถูกกว่า"} ${baseLabel} ${num(Math.abs(change), 0)}%`),
        el("span", "", `จาก ${num(base, 2)} เป็น ${num(dish.cost_now, 2)} บาทต่อจาน`),
      );
    }

    // แท่งเทียบ: 10 ปีก่อน → 5 ปีก่อน → ปีก่อน → วันนี้ → AI ทาย (สูงตามราคา)
    const steps = [
      ["10 ปีก่อน", dish.cost_10y_ago, ""], ["5 ปีก่อน", dish.cost_5y_ago, ""], ["ปีก่อน", dish.cost_1y_ago, ""],
      ["วันนี้", dish.cost_now, "now"], [`AI ทาย ${dish.target_period ? thMonth(dish.target_period) : "เดือนหน้า"}`, dish.cost_next, "ai"],
    ].filter(([, v]) => v !== null && v !== undefined);
    const top = Math.max(...steps.map(([, v]) => v));
    const box = $("dish-timeline");
    box.replaceChildren();
    for (const [index, [label, value, kind]] of steps.entries()) {
      const step = el("div", `step ${kind}`.trim());
      step.style.setProperty("--delay", `${index * 140 + (kind === "ai" ? 200 : 0)}ms`);
      const bar = el("div", "step-bar");
      bar.style.height = `calc((100% - 72px) * ${(value / top).toFixed(3)})`;
      step.append(el("span", "step-value", num(value, 2)), bar, el("span", "step-label", label));
      box.appendChild(step);
    }
  }

  // ---------- หน้า 2: จังหวัดไหนแพงเร็ว ----------
  // เรื่องที่คนทั่วไปสนใจ (ข้อมูลครบทุกจังหวัด) แทนรายการหมวดทั้งหมดหลายสิบหมวด
  const MAP_TOPICS = [
    ["00000", "รวมทุกอย่าง"], ["10000", "อาหาร"], ["11000", "ของสดทำกินเอง"], ["12000", "อาหารซื้อกิน"],
    ["32000", "ค่าไฟ น้ำ แก๊ส"], ["52000", "รถและน้ำมันรถ"],
    // 54100 = ค่าบริการการสื่อสาร (ค่ามือถือและเน็ตรวมกัน ไม่รวมตัวเครื่อง) · 41000 = ค่ายาและค่ารักษาพยาบาล
    ["54100", "ค่ามือถือและเน็ต"], ["41000", "ค่ายาและค่ารักษา"],
    ["31000", "ค่าเช่าบ้าน"], ["62000", "การศึกษา"],
  ];
  let mapHandle = null;
  let mapSelected = null;
  async function renderMapPage() {
    const [commodities, geo] = await Promise.all([
      commoditiesP(),
      once("geo", () => api("/static/thailand_provinces.geojson")),
    ]);
    const select = $("map-commodity");
    if (!select.options.length) {
      const available = new Set(commodities.map((c) => c.commodity_code));
      fillSelect(select, MAP_TOPICS.filter(([code]) => available.has(code)).map(([value, label]) => ({ value, label })), "00000");
      chipSelect(select);
      select.addEventListener("change", () => drawMap(geo));
    }
    await drawMap(geo);
  }

  async function drawMap(geo) {
    const code = $("map-commodity").value;
    const topic = $("map-commodity").selectedOptions[0]?.textContent.trim();
    const data = await once(`map-${code}`, () => api(`/api/map?commodity_code=${code}`));
    const values = new Map();
    for (const item of data.items) {
      values.set(item.code, {
        value: item.yoy,
        extra: [
          { label: "จากเดือนก่อน", value: pct(item.mom) },
          { label: "เดือนหน้า (คาด)", value: pct(item.predicted_change_pct) },
        ],
        item,
      });
    }
    // สเกลสีใช้ percentile 95 ของค่าสัมบูรณ์ ไม่ให้จังหวัดเดียวที่ผิดปกติทำให้สีจางทั้งแผนที่
    const abs = data.items.map((i) => Math.abs(i.yoy ?? 0)).sort((a, b) => a - b);
    const p95 = abs[Math.floor(abs.length * 0.95)] || 1;
    const maxAbs = Math.max(0.5, Math.ceil(p95 * 2) / 2);
    mapHandle = map($("map"), geo, {
      values, maxAbs, format: (v) => pct(v), valueLabel: "จากปีก่อน",
      onSelect: (provinceCode) => selectProvince(provinceCode, values, data),
    });
    divergingLegend($("map-legend"), maxAbs, (v) => pct(v, 1));
    const ranked = data.items.filter((i) => i.yoy !== null);
    tableRows($("map-table"), [
      { label: "#" }, { label: "จังหวัด" }, { label: "จากปีก่อน", num: true }, { label: "จากเดือนก่อน", num: true }, { label: "เดือนหน้า (คาด)", num: true },
    ], ranked.map((item, index) => {
      const name = el("span");
      const swatch = el("i", "swatch");
      swatch.style.background = Charts.divergingColor(item.yoy, maxAbs);
      name.append(swatch, document.createTextNode(item.name));
      return { code: item.code, cells: [String(index + 1), name, pct(item.yoy), pct(item.mom), pct(item.predicted_change_pct)] };
    }), (row) => selectProvince(row.code, values, data));
    selectProvince(mapSelected && values.has(mapSelected) ? mapSelected : ranked[0]?.code, values, data);
    stopTimelapse();
    mapNames = new Map(data.items.map((item) => [item.code, item.name]));
    $("map-month").textContent = thMonth(data.period);
    $("map-caption").textContent = "";
    $("map-slider").disabled = true;

    if (ranked.length) {
      const top = ranked[0], bottom = ranked[ranked.length - 1];
      $("map-takeaway").textContent = `${code === "00000" ? "" : `เรื่อง${topic}: `}${top.name}แพงขึ้นเร็วที่สุด (${pct(top.yoy, 1)} จากปีก่อน)${bottom.yoy >= 0 ? ` ส่วน${bottom.name}ขึ้นช้าที่สุด (${pct(bottom.yoy, 1)})` : ` ส่วน${bottom.name}${moveText(bottom.yoy, 1)}`}`;
    }
  }

  // ---------- แผนที่เล่นย้อนเวลา ----------
  let mapNames = new Map();
  let playTimer = null;
  let timelapse = null; // { history, maxAbs }
  function stopTimelapse() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    $("map-play").textContent = "▶ เล่นย้อนหลัง 5 ปี";
  }
  function showFrame(index) {
    const { history, maxAbs } = timelapse;
    const values = new Map();
    for (const [code, list] of Object.entries(history.values)) {
      if (list[index] !== null && list[index] !== undefined) values.set(code, { value: list[index], extra: [] });
    }
    mapHandle.recolor(values, maxAbs);
    $("map-slider").value = String(index);
    $("map-month").textContent = thMonth(history.periods[index]);
    const entries = [...values.entries()];
    if (entries.length) {
      const mean = entries.reduce((sum, [, record]) => sum + record.value, 0) / entries.length;
      const [topCode, top] = entries.reduce((best, entry) => (entry[1].value > best[1].value ? entry : best));
      $("map-caption").textContent = `${entries.length} จังหวัดเฉลี่ย${moveText(mean, 1)} จากปีก่อน · เร็วที่สุด: ${mapNames.get(topCode) || topCode} (${pct(top.value, 1)})`;
    }
  }
  async function loadTimelapse() {
    const code = $("map-commodity").value;
    const history = await once(`maphist-${code}`, () => api(`/api/map/history?commodity_code=${code}`));
    // สเกลสีเดียวทั้ง 5 ปี (percentile 95) จึงเทียบสีข้ามเดือนได้
    const all = Object.values(history.values).flat().filter((v) => v !== null).map(Math.abs).sort((a, b) => a - b);
    const maxAbs = Math.max(0.5, Math.ceil((all[Math.floor(all.length * 0.95)] || 1) * 2) / 2);
    timelapse = { history, maxAbs };
    divergingLegend($("map-legend"), maxAbs, (v) => pct(v, 1));
    const slider = $("map-slider");
    slider.max = String(history.periods.length - 1);
    slider.disabled = false;
    return timelapse;
  }
  async function togglePlay() {
    if (playTimer) { stopTimelapse(); return; }
    const { history } = await loadTimelapse();
    const last = history.periods.length - 1;
    let index = Number($("map-slider").value);
    if (!(index >= 0 && index < last)) index = 0;
    showFrame(index);
    $("map-play").textContent = "⏸ หยุด";
    playTimer = setInterval(() => {
      index += 1;
      showFrame(index);
      if (index >= last) stopTimelapse();
    }, 350);
  }
  $("map-play").addEventListener("click", togglePlay);
  $("map-slider").addEventListener("input", async () => {
    stopTimelapse();
    if (!timelapse) await loadTimelapse();
    showFrame(Number($("map-slider").value));
  });

  function selectProvince(code, values, data) {
    const record = values.get(code);
    if (!record) return;
    mapSelected = code;
    mapHandle && mapHandle.select(code);
    const item = record.item;
    const card = $("map-detail");
    card.replaceChildren();
    const topic = $("map-commodity").selectedOptions[0]?.textContent.trim();
    card.append(
      el("div", "muted", `${topic} · ${thMonth(data.period)} เทียบกับปีก่อน`),
      el("h2", "", item.name),
      el("div", "value", moveText(item.yoy)),
      moneyLine("ของที่ปีก่อนจ่าย ", "100 บาท", " ตอนนี้ต้องจ่าย ", item.yoy === null ? "–" : `${num(100 + item.yoy, 2)} บาท`),
      el("div", "muted", `จากเดือนก่อน ${pct(item.mom)} · เดือนหน้าคาดว่า ${pct(item.predicted_change_pct)}`),
    );
  }

  // ---------- แถบ AI บนหน้าแรก ----------
  function renderAiBanner(fc, products) {
    const card = $("ai-banner");
    card.replaceChildren();
    if (!fc) { card.hidden = true; return; }
    const value = el("div", "ai-value", `ของโดยรวมจะ${fc.predicted_change_pct >= 0 ? "แพงขึ้นอีก" : "ถูกลง"} `);
    const aiPct = el("b");
    value.appendChild(aiPct);
    countUp(aiPct, Math.abs(fc.predicted_change_pct), { format: (v) => `${num(v, 2)}%`, duration: 1400 });
    const rows = el("div", "ai-rows");
    for (const [id, name] of [["P11028", "ไข่ไก่ เบอร์ 3"], ["P11003", "หมูสะโพก"], ["F52002", "แก๊สโซฮอล์ 95"]]) {
      const product = products.find((p) => p.product_id === id);
      if (!product || !product.next_month_price) continue;
      const row = el("div", "ai-row");
      const price = el("b", "", `≈ ${num(product.next_month_price, 2)}`);
      price.appendChild(el("small", "", `฿${perUnit(product.unit)}`));
      row.append(el("span", "", name), price);
      rows.appendChild(row);
    }
    const link = withIcon(el("a", "ai-link", "ดูว่า AI ทายแม่นแค่ไหน"), "arrow");
    link.href = "#forecast";
    card.append(aiLabel(`AI ทายเดือน ${thMonth(fc.target_period)}`), value, rows, link);
  }

  // ---------- หน้า 3: เดือนหน้าเป็นไง (เฉพาะหมวดที่มีราคาจริงเป็นบาท) ----------
  const FORECAST_CATEGORIES = [
    ["11310", "ไข่"], ["11211", "หมู / เนื้อวัว"], ["11221", "ไก่ / เป็ด"], ["11232", "ปลาทะเล"], ["11231", "ปลาน้ำจืด"],
    ["11233", "กุ้ง หอย ปลาหมึก"], ["11411", "ผักสด"], ["11421", "ผลไม้"], ["11110", "ข้าวสาร"], ["11521", "น้ำมันพืช"], ["52200", "น้ำมันรถ"],
  ];
  const categoryName = (code) => (FORECAST_CATEGORIES.find(([c]) => c === code) || [code, code])[1];
  let fcCategory = "11310";
  let fcProductId = "P11028";
  let fcCurrent = null;

  async function renderForecastPage() {
    const products = (await pricesP()).filter((p) => p.next_month_price !== null);
    const chips = $("fc-categories");
    if (!chips.children.length) {
      for (const [code, label] of FORECAST_CATEGORIES.filter(([code]) => products.some((p) => p.cpi_code === code))) {
        const button = el("button", "", label);
        button.dataset.category = code;
        chips.appendChild(button);
      }
      chips.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-category]");
        if (!button) return;
        fcCategory = button.dataset.category;
        const inCategory = products.filter((p) => p.cpi_code === fcCategory);
        fcProductId = (inCategory.find((p) => STAPLES.includes(p.product_id) || p.product_id === "F52002") || inCategory[0]).product_id;
        fillProductSelect(products);
        drawForecastProduct();
      });
      picker($("fc-product"), { searchPlaceholder: "ค้นหาสินค้า" });
      $("fc-product").addEventListener("change", () => { fcProductId = $("fc-product").value; drawForecastProduct(); });
      $("fc-live").addEventListener("click", predictLive);
    }
    fillProductSelect(products);
    await drawForecastProduct();
    await Promise.all([renderMovers(), renderForecastAccuracy()]);
  }

  function fillProductSelect(products) {
    document.querySelectorAll("#fc-categories button").forEach((b) => b.classList.toggle("active", b.dataset.category === fcCategory));
    const inCategory = products.filter((p) => p.cpi_code === fcCategory).sort((a, b) => a.label.localeCompare(b.label, "th"));
    fillSelect($("fc-product"), inCategory.map((p) => ({ value: p.product_id, label: `${p.label} (${p.unit})` })), fcProductId);
  }

  async function drawForecastProduct() {
    const container = $("chart-forecast");
    try {
      const data = await api(`/api/forecast/product?product_id=${fcProductId}`);
      const product = data.product;
      fcCurrent = product;
      $("fc-title").textContent = `${product.label} (${product.unit})`;
      const color = cssVar("--actual");
      const series = [{ name: "ราคาจริงเฉลี่ยรายเดือน", color, area: true, areaOpacity: 0.1, endLabel: false, points: data.monthly.filter((m) => !product.target_period || m.period_date < product.target_period).slice(-24).map((m) => [parseDate(m.period_date), m.avg_price]) }];
      if (product.next_month_price) {
        series.push({ name: "ที่ AI ทาย", color: cssVar("--forecast"), dashed: true, endLabel: false, points: [[parseDate(product.base_period), product.base_month_price], [parseDate(product.target_period), product.next_month_price]] });
      }
      line(container, {
        series, forceLegend: true, ariaLabel: "ราคาจริงและที่ AI ทาย",
        yFormat: (v, isAxis) => (isAxis ? num(v, Math.abs(v) < 10 ? 2 : v < 100 ? 1 : 0) : bahtPrice(v)),
      });
      renderForecastBadge(product, product.predicted_change_pct, "ผลจากรอบล่าสุดของ Airflow");
      renderBacktest(data);
    } catch (error) { showError(container, error); }
  }

  function renderForecastBadge(product, change, note) {
    const badge = $("fc-badge");
    badge.replaceChildren();
    if (change === null || change === undefined || !product.base_month_price) { badge.appendChild(el("div", "muted", "ยังไม่มีค่าที่ AI ทาย")); return; }
    const predicted = product.base_month_price * (1 + change / 100);
    const big = el("div", "badge-big");
    big.append(el("b", "", num(predicted, predicted >= 1000 ? 0 : 2)), el("span", "", `฿${perUnit(product.unit)}`));
    const move = el("div", "badge-change", `${change > 0.005 ? "▲" : change < -0.005 ? "▼" : "●"} ${moveText(change)} จาก ${thMonth(product.base_period)} (${bahtPrice(product.base_month_price)})`);
    move.style.color = changeColor(change);
    badge.append(aiLabel(`AI ทายราคาเฉลี่ย ${thMonth(product.target_period)}`), big, move);
    if (product.target_month_actual) {
      const actual = el("div", "badge-actual", `ราคาจริง ${thMonth(product.target_period)} ถึงตอนนี้ (${product.target_month_days} วันที่สำรวจ) ≈ `);
      actual.appendChild(el("b", "", bahtPrice(product.target_month_actual)));
      badge.appendChild(actual);
    }
    badge.appendChild(el("div", "muted", note));
  }

  async function predictLive() {
    const button = $("fc-live");
    if (!fcCurrent) return;
    button.disabled = true;
    button.textContent = "AI กำลังคิด…";
    const number = $("fc-badge").querySelector(".badge-big b");
    const stopShuffle = number ? shuffleDigits(number) : () => {};
    try {
      const [p] = await Promise.all([
        api("/api/predict", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ area_key: "region:10", commodity_code: fcCurrent.cpi_code }),
        }),
        sleep(reduceMotion ? 0 : 900),
      ]);
      stopShuffle();
      renderForecastBadge(fcCurrent, p.predicted_change_pct, "ทายใหม่เมื่อสักครู่");
      $("fc-badge").querySelector(".badge-big")?.classList.add("settled");
    } catch (error) {
      stopShuffle();
      $("fc-badge").replaceChildren(el("div", "muted", `ทายไม่ได้: ${error.message}`));
    } finally {
      button.disabled = false;
      button.textContent = "ให้ AI ทายใหม่ตอนนี้";
    }
  }

  function renderBacktest(data) {
    const tiles = $("fc-bt-tiles");
    const container = $("chart-backtest");
    tiles.replaceChildren();
    const s = data.summary;
    if (!s) {
      $("fc-bt-sub").textContent = "ยังไม่มีผลทดสอบของสินค้านี้ (ต้องมีราคาจริงช่วงที่ทดสอบ)";
      container.replaceChildren(el("div", "empty-state", "ยังไม่มีข้อมูลทดสอบ"));
      return;
    }
    const rows = data.backtest;
    $("fc-bt-sub").textContent = `AI เรียนข้อมูลถึง ${thMonth(s.trained_through)} แล้วทาย ${s.months} เดือนถัดมาที่ไม่เคยเห็น`;
    const better = s.naive_error_pct - s.ai_error_pct;
    tile(tiles, { label: "ทายราคาพลาดเฉลี่ย", value: `±${num(s.ai_error_pct, 1)}%`, sub: `ต่อเดือน · ${data.product.label}`, icon: "target", tone: "purple" });
    tile(tiles, {
      label: "เทียบกับเดาว่า \"ราคาเท่าเดิม\"", value: better >= 0 ? `แม่นกว่า ${num(better, 1)} จุด` : `พลาดมากกว่า ${num(-better, 1)} จุด`,
      sub: `เดาว่าเท่าเดิมพลาดเฉลี่ย ±${num(s.naive_error_pct, 1)}%`, icon: "equal", tone: better >= 0 ? "green" : "pink",
    });
    tile(tiles, {
      label: "ทายถูกว่าจะขึ้นหรือลง", value: s.direction_months ? `${s.direction_hits} จาก ${s.direction_months} เดือน` : "–",
      sub: "นับเฉพาะเดือนที่ราคาขยับจริง", icon: "updown", tone: "blue",
    });
    line(container, {
      forceLegend: true, endLabels: false, ariaLabel: "AI ทายไว้เทียบกับราคาจริง",
      yFormat: (v, isAxis) => (isAxis ? num(v, Math.abs(v) < 10 ? 2 : v < 100 ? 1 : 0) : bahtPrice(v)),
      series: [
        { name: "ราคาจริง", color: cssVar("--actual"), points: rows.map((r) => [parseDate(r.target_period), r.actual_price]) },
        { name: "AI ทายไว้ล่วงหน้า 1 เดือน", color: cssVar("--forecast"), dashed: true, points: rows.map((r) => [parseDate(r.target_period), r.predicted_price]) },
      ],
    });
  }

  function productRow(container, product) {
    const look = productLook(product.label);
    const row = el("button", "pf-row");
    row.type = "button";
    const name = el("div", "pf-name");
    name.append(el("b", "", product.label), el("span", "muted", `${categoryName(product.cpi_code)} · ${product.unit}`));
    const next = el("div", "pf-next", num(product.next_month_price, 2));
    next.style.color = changeColor(product.predicted_change_pct);
    const chg = el("div", "pf-chg");
    chg.appendChild(deltaNode(product.predicted_change_pct, "%"));
    row.append(plate(look.icon), name, el("div", "pf-now", num(product.base_month_price, 2)), el("div", "pf-arrow", "→"), next, chg);
    row.addEventListener("click", () => {
      fcCategory = product.cpi_code;
      fcProductId = product.product_id;
      pricesP().then((products) => { fillProductSelect(products.filter((p) => p.next_month_price !== null)); drawForecastProduct(); });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    container.appendChild(row);
  }

  async function renderMovers() {
    try {
      const [data, summary] = await Promise.all([once("movers", () => api("/api/forecast/products?n=6")), summaryP()]);
      for (const [id, items] of [["fc-rising", data.rising], ["fc-falling", data.falling]]) {
        const box = $(id);
        box.replaceChildren();
        if (!items.length) box.appendChild(el("div", "empty-state", "ไม่มี"));
        for (const product of items) productRow(box, product);
      }
      const sample = data.rising[0] || data.falling[0];
      if (sample) {
        const text = `${thMonth(sample.base_period)} → ${thMonth(sample.target_period)}`;
        $("fc-rising-sub").textContent = text;
        $("fc-falling-sub").textContent = text;
      }
      const fc = summary.forecast["00000"];
      const up = data.rising[0];
      const parts = [];
      if (fc) parts.push(`AI คาดว่าเดือน ${thMonth(fc.target_period)} ของโดยรวมจะ${moveText(fc.predicted_change_pct)}`);
      if (up) parts.push(`${fc ? " ตัวที่" : "ตัวที่"}น่าจะขึ้นแรงสุดคือ${up.label} (${pct(up.predicted_change_pct, 1)})`);
      $("fc-takeaway").textContent = parts.join("");
    } catch (error) { showError($("fc-rising"), error); }
  }

  const championOf = (metrics) => [...metrics].reverse().find((m) => m.deployed) || metrics[metrics.length - 1];
  async function renderForecastAccuracy() {
    try {
      const champion = championOf(await metricsP());
      if (!champion) return;
      const gain = (1 - champion.rmse / champion.baseline_rmse) * 100;
      $("fc-accuracy").textContent = `ควรรู้: AI ใช้ดูแนวโน้มว่าจะขึ้นหรือลง ไม่ได้ทายเป๊ะ · ทดสอบทุกหมวดพลาดเฉลี่ย ±${num(champion.mae, 1)}% ต่อเดือน ทายทิศทางถูก ${num(champion.direction_accuracy * 100, 0)}% แม่นกว่าเดาว่า "ราคาเท่าเดิม" ${num(gain, 0)}%`;
    } catch (error) { $("fc-accuracy").textContent = ""; }
  }

  // ---------- หน้า 4: ค่าแรงพอไหม ----------
  async function renderWagePage() {
    const provinces = await once("wage-prov", () => api("/api/wage/provinces"));
    const select = $("wage-province");
    if (!select.options.length) {
      const sorted = [...provinces].sort((a, b) => a.province_name.localeCompare(b.province_name, "th"));
      fillSelect(select, sorted.map((p) => ({ value: p.province_code, label: p.province_name })), "10");
      picker(select, { searchPlaceholder: "ค้นหาจังหวัด" });
      select.addEventListener("change", drawWage);
    }
    await drawWage();
    const first = provinces[0];
    $("wage-table-sub").textContent = first ? `ซื้อของได้มากขึ้น/น้อยลง เทียบกับ ${thMonth(first.first_period)} · กดแถวเพื่อดูจังหวัดนั้น` : "";
    drawWageTable(provinces);
  }

  // ตารางค่าแรงแสดง 10 จังหวัดแรกก่อน กดปุ่มเพื่อดูครบทุกจังหวัด
  const WAGE_ROWS = 10;
  let wageShowAll = false;
  function drawWageTable(provinces) {
    const select = $("wage-province");
    tableRows($("wage-table"), [
      { label: "จังหวัด" }, { label: "ค่าแรงวันละ", num: true }, { label: "หักของแพงแล้วเหลือ (เงินปี 2566)", num: true }, { label: "ซื้อของได้มากขึ้น/น้อยลง", num: true },
    ], (wageShowAll ? provinces : provinces.slice(0, WAGE_ROWS)).map((p) => ({ code: p.province_code, cells: [p.province_name, `${num(p.nominal_wage, 0)} ฿`, `${num(p.real_wage, 0)} ฿`, deltaNode(p.real_change_pct, "%", false)] })),
    (row) => { select.value = row.code; drawWage(); window.scrollTo({ top: 0, behavior: "smooth" }); });
    const more = $("wage-more");
    more.hidden = wageShowAll || provinces.length <= WAGE_ROWS;
    more.textContent = `ดูทุกจังหวัด (${provinces.length})`;
    more.onclick = () => { wageShowAll = true; drawWageTable(provinces); };
  }

  // ราคาต่อหน่วยจากหน่วยของกรมการค้าภายใน เช่น "บาท/15กก." -> ราคาต่อ 1 กก.
  function unitOf(product) {
    const match = /\/\s*(\d+(?:\.\d+)?)?\s*(.+)$/.exec(product.unit || "");
    return { size: match && match[1] ? Number(match[1]) : 1, unit: match ? match[2].trim() : "" };
  }
  function unitPrice(product) {
    const { size, unit } = unitOf(product);
    return { price: product.latest_price / size, unit };
  }

  async function drawWage() {
    const code = $("wage-province").value;
    const [data, products] = await Promise.all([api(`/api/wage?province_code=${code}`), pricesP()]);
    const points = data.points;
    const tiles = $("wage-tiles");
    tiles.replaceChildren();
    if (!points.length) { tiles.appendChild(el("div", "empty-state", "ไม่มีข้อมูลค่าแรงของจังหวัดนี้")); return; }
    const first = points[0], last = points[points.length - 1];
    const power = (last.real_wage / first.real_wage - 1) * 100;
    const egg = products.find((p) => p.product_id === "P11028");
    const eggs = egg ? last.nominal_wage / egg.latest_price : null;
    tile(tiles, { label: `ค่าแรงขั้นต่ำ ${thMonth(last.period_date)}`, value: `${num(last.nominal_wage, 0)} ฿/วัน`, sub: `เมื่อ ${thMonth(first.period_date)} วันละ ${num(first.nominal_wage, 0)} ฿`, icon: "wallet", tone: "orange" });
    tile(tiles, { label: "ถ้าหักของที่แพงขึ้นแล้ว เท่ากับเงินปี 2566", value: `${num(last.real_wage, 0)} ฿`, sub: `เมื่อ ${thMonth(first.period_date)} เท่ากับ ${num(first.real_wage, 0)} ฿`, icon: "coins", tone: "blue" });
    tile(tiles, { label: `ซื้อของได้${power >= 0 ? "มากขึ้น" : "น้อยลง"}`, value: `${num(Math.abs(power), 1)}%`, sub: power >= 0 ? "ค่าแรงขึ้นเร็วกว่าของแพง" : "ของแพงขึ้นเร็วกว่าค่าแรง", icon: "scale", tone: "green" });
    tile(tiles, egg
      ? { label: "ค่าแรง 1 วัน ซื้อไข่ไก่เบอร์ 3 ได้", value: `${num(eggs, 0)} ฟอง`, sub: `ไข่ฟองละ ${bahtPrice(egg.latest_price)}`, icon: "egg", tone: "amber" }
      : { label: "ค่าแรง 1 วัน ซื้อไข่ได้", value: "–", sub: "ยังไม่มีราคาไข่", icon: "egg", tone: "amber" });

    // ค่าแรง 1 วันซื้ออะไรได้บ้าง (ราคาตลาดกรุงเทพฯ)
    const list = $("buy-list");
    list.replaceChildren();
    for (const product of BUY_ITEMS.map((id) => products.find((p) => p.product_id === id)).filter(Boolean)) {
      const { price, unit } = unitPrice(product);
      const quantity = last.nominal_wage / price;
      const look = productLook(product.label);
      const item = el("div", `buy-item tone-${look.tone}`);
      const body = el("div");
      body.append(el("div", "buy-qty", `${num(quantity, quantity < 20 ? 1 : 0)} ${unit}`), el("div", "muted", product.label));
      item.append(plate(look.icon), body);
      list.appendChild(item);
    }
    $("buy-sub").textContent = `ซื้อได้อย่างใดอย่างหนึ่ง · ราคาตลาดกรุงเทพฯ${code === "10" ? "" : " (จังหวัดอื่นอาจต่างจากนี้)"}`;

    $("wage-takeaway").textContent = `ค่าแรงขั้นต่ำ${data.province_name}วันละ ${num(last.nominal_wage, 0)} บาท ซื้อของได้${power >= 0 ? "มากขึ้น" : "น้อยลง"} ${num(Math.abs(power), 1)}% เทียบกับ ${thMonth(first.period_date)}`;

    line($("chart-wage"), {
      yFormat: (v) => num(v, 0), ariaLabel: "ค่าแรงขั้นต่ำและค่าแรงเมื่อหักของแพงแล้ว",
      series: [
        { name: "ค่าแรงตามประกาศ", short: "ประกาศ", color: cssVar("--series-2"), points: points.map((p) => [parseDate(p.period_date), p.nominal_wage]) },
        { name: "หักของแพงแล้ว (เงินปี 2566)", short: "หักของแพง", color: cssVar("--series-1"), area: true, points: points.map((p) => [parseDate(p.period_date), p.real_wage]) },
      ],
    });
  }

  // ---------- หน้า 5: ตะกร้าของฉัน (หน้าร้านแบบแพลตฟอร์มช้อปปิ้ง ใช้ราคาจริง) ----------
  // ตะกร้าเก็บใน localStorage ของเบราว์เซอร์นี้ (ไม่ส่งขึ้นเซิร์ฟเวอร์) จำนวนเป็นหน่วยย่อย เช่น ข้าว 15 กก./ถุง -> ใส่เป็น กก.
  const BASKET_KEY = "col-basket-v1";
  const DEFAULT_BASKET = [
    { id: "P11028", qty: 30 }, { id: "P11003", qty: 1 }, { id: "R13001", qty: 5 },
    { id: "P13001", qty: 1 }, { id: "P16011", qty: 1 }, { id: "F52002", qty: 40 },
  ];
  function loadBasket() {
    try {
      const saved = JSON.parse(localStorage.getItem(BASKET_KEY) || "null");
      if (Array.isArray(saved)) return saved.filter((i) => /^[A-Z]\d{5}$/.test(i?.id) && Number.isFinite(i.qty) && i.qty > 0);
    } catch (error) { /* เบราว์เซอร์ปิดการเก็บข้อมูล ใช้ตะกร้าตัวอย่างแทน */ }
    return null;
  }
  let basket = loadBasket() ?? DEFAULT_BASKET.map((i) => ({ ...i }));
  let basketProducts = new Map();
  let basketHistory = null; // { key, data }
  let basketChartDrawn = false;
  const shop = { query: "", group: "", sort: "staple", limit: 24, cards: new Map() };
  const SHOP_PAGE = 24;
  const inBasket = (id) => basket.some((i) => i.id === id);
  const basketItem = (id) => basket.find((i) => i.id === id);
  const wholeBaht = (v) => `${num(v, 0)} บาท`;
  // จำนวนเริ่มต้นและขั้นของปุ่ม +/- ตามหน่วย
  const qtyStep = (unit) => (/กก/.test(unit) ? 0.5 : 1);
  const defaultQty = (unit) => (/ฟอง/.test(unit) ? 10 : /ลิตร/.test(unit) ? 10 : 1);
  const fmtQty = (q) => num(q, Number.isInteger(q) ? 0 : 1);

  function saveBasket() {
    try { localStorage.setItem(BASKET_KEY, JSON.stringify(basket)); } catch (error) { /* ใช้ได้ต่อโดยไม่จำ */ }
    const count = $("basket-count");
    if (count.textContent !== String(basket.length) && !count.hidden) {
      count.classList.remove("bump"); void count.offsetWidth; count.classList.add("bump");
    }
    count.textContent = String(basket.length);
    count.hidden = !basket.length;
    syncAddButtons();
  }
  function syncAddButtons() {
    document.querySelectorAll(".add-basket").forEach((button) => {
      const added = inBasket(button.dataset.product);
      button.classList.toggle("added", added);
      button.textContent = added ? "✓ ในตะกร้า" : "+ ตะกร้า";
      button.setAttribute("aria-label", added ? "อยู่ในตะกร้าแล้ว ไปที่ตะกร้า" : "ใส่ตะกร้า");
    });
  }
  // ทุกการเปลี่ยนแปลงของตะกร้าผ่านฟังก์ชันนี้: บันทึก แล้ววาดการ์ดสินค้าตัวนั้นกับตะกร้าใหม่
  function setBasketQty(id, qty) {
    const value = Math.max(0, Math.round(qty * 100) / 100);
    const item = basketItem(id);
    if (value <= 0) basket = basket.filter((i) => i.id !== id);
    else if (item) item.qty = value;
    else basket.push({ id, qty: value });
    saveBasket();
    shop.cards.get(id)?._refresh();
    if (!$("page-basket").hidden) drawCart();
  }
  function addToBasket(product) {
    if (!inBasket(product.product_id)) setBasketQty(product.product_id, defaultQty(unitOf(product).unit));
  }

  // ยอดรวม: วันนี้, ปีก่อน, เฉลี่ยเดือนฐาน และที่ AI ทาย (สินค้าที่ไม่มีข้อมูลบางช่องใช้ราคาปัจจุบันแทน และนับไว้บอกผู้ใช้)
  function basketTotals() {
    const totals = { now: 0, yearAgo: 0, base: 0, next: 0, missingYear: 0, missingAi: 0, target: null, basePeriod: null, latest: "" };
    for (const item of basket) {
      const p = basketProducts.get(item.id);
      if (!p) continue;
      const k = item.qty / unitOf(p).size;
      totals.now += k * p.latest_price;
      totals.yearAgo += k * (p.price_1y_ago ?? p.latest_price);
      if (p.price_1y_ago == null) totals.missingYear += 1;
      const base = p.base_month_price ?? p.latest_price;
      totals.base += k * base;
      totals.next += k * (p.next_month_price ?? base);
      if (p.next_month_price == null) totals.missingAi += 1;
      totals.target ??= p.target_period;
      totals.basePeriod ??= p.base_period;
      if (p.price_date > totals.latest) totals.latest = p.price_date;
    }
    return totals;
  }

  // ปุ่ม − จำนวน + ใช้ทั้งในการ์ดสินค้าและในตะกร้า
  function stepper(product, item, { compact = false } = {}) {
    const { unit } = unitOf(product);
    const box = el("div", compact ? "stepper stepper-sm" : "stepper");
    const minus = el("button", "", "−");
    const plus = el("button", "", "+");
    const input = el("input");
    minus.type = plus.type = "button";
    input.type = "number"; input.min = "0"; input.step = String(qtyStep(unit)); input.inputMode = "decimal";
    input.value = String(item.qty);
    input.setAttribute("aria-label", `จำนวน${product.label} (${unit})`);
    minus.setAttribute("aria-label", `ลด${product.label}`);
    plus.setAttribute("aria-label", `เพิ่ม${product.label}`);
    minus.addEventListener("click", () => setBasketQty(product.product_id, item.qty - qtyStep(unit)));
    plus.addEventListener("click", () => setBasketQty(product.product_id, item.qty + qtyStep(unit)));
    input.addEventListener("change", () => setBasketQty(product.product_id, Number(input.value) || 0));
    box.append(minus, input, el("span", "stepper-unit", unit), plus);
    return box;
  }

  // การ์ดสินค้าแบบร้านค้าออนไลน์: รูป (ไอคอน), ชื่อ, ราคาวันนี้, ราคาปีก่อนขีดฆ่า + ป้าย %, ปุ่มใส่ตะกร้า
  function shopCard(p) {
    const look = productLook(p.label);
    const card = el("article", "shop-card");
    const thumb = withIcon(el("div", "shop-thumb"), look.icon);
    const photo = productPhoto(p.label);
    if (photo) { thumb.classList.add("has-photo"); thumb.appendChild(photoImg(photo, "shop-photo")); }
    if (STAPLES.includes(p.product_id) || p.product_id === "F52002") thumb.appendChild(el("span", "shop-tag", "ของใช้ประจำ"));
    if (p.predicted_change_pct != null) {
      const ai = el("span", "shop-ai", `AI เดือนหน้า ${p.predicted_change_pct > 0.005 ? "▲" : p.predicted_change_pct < -0.005 ? "▼" : "●"} ${num(Math.abs(p.predicted_change_pct), 1)}%`);
      thumb.appendChild(ai);
    }
    const body = el("div", "shop-body");
    const name = el("h3", "shop-name", p.label);
    name.title = p.label;
    const price = el("div", "shop-price");
    price.append(el("b", "", num(p.latest_price, p.latest_price >= 1000 ? 0 : 2)), el("span", "", `฿${perUnit(p.unit)}`));
    const was = el("div", "shop-was");
    const yoy = yoyPct(p);
    if (p.price_1y_ago != null) {
      const old = el("s", "", `${num(p.price_1y_ago, 2)} ฿`);
      old.setAttribute("aria-label", `ปีก่อน ${num(p.price_1y_ago, 2)} บาท`);
      was.append(old, deltaNode(yoy, "%"));
    } else {
      was.appendChild(el("span", "muted", "ยังไม่มีราคาปีก่อน"));
    }
    const action = el("div", "shop-action");
    body.append(name, price, was, action);
    card.append(thumb, body);
    card._refresh = () => {
      const item = basketItem(p.product_id);
      action.replaceChildren();
      card.classList.toggle("in-cart", !!item);
      if (item) { action.appendChild(stepper(p, item)); return; }
      const add = withIcon(el("button", "shop-add", "ใส่ตะกร้า"), "cart");
      add.type = "button";
      add.addEventListener("click", () => {
        addToBasket(p);
        shop.cards.get(p.product_id)?.querySelector(".stepper button:last-child")?.focus();
      });
      action.appendChild(add);
    };
    card._refresh();
    return card;
  }

  function drawShop() {
    const q = shop.query.trim();
    const rank = (p) => { const i = STAPLES.indexOf(p.product_id); return i === -1 ? (p.product_id === "F52002" ? STAPLES.length : STAPLES.length + 1) : i; };
    const sorters = {
      staple: (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, "th"),
      up: (a, b) => (yoyPct(b) ?? -1e9) - (yoyPct(a) ?? -1e9),
      down: (a, b) => (yoyPct(a) ?? 1e9) - (yoyPct(b) ?? 1e9),
      cheap: (a, b) => a.latest_price / unitOf(a).size - b.latest_price / unitOf(b).size,
    };
    const matched = [...basketProducts.values()]
      .filter((p) => (!shop.group || p.product_group === shop.group) && (!q || p.label.includes(q)))
      .sort(sorters[shop.sort] || sorters.staple);
    const grid = $("shop-grid");
    grid.replaceChildren();
    shop.cards.clear();
    if (!matched.length) grid.appendChild(el("div", "empty-state", "ไม่พบสินค้าที่ค้นหา"));
    for (const [i, p] of matched.slice(0, shop.limit).entries()) {
      const card = shopCard(p);
      card.style.setProperty("--i", String(i % PAGE_SIZE));
      shop.cards.set(p.product_id, card);
      grid.appendChild(card);
    }
    $("shop-count").textContent = `${compact(matched.length)} รายการ${q ? ` ที่ตรงกับ "${q}"` : ""}`;
    $("shop-more").hidden = matched.length <= shop.limit;
    $("shop-more").textContent = `ดูสินค้าเพิ่ม (เหลืออีก ${compact(matched.length - shop.limit)} รายการ)`;
  }

  function drawCart() {
    const list = $("cart-list");
    list.replaceChildren();
    $("cart-count").textContent = `(${basket.length})`;
    if (!basket.length) list.appendChild(el("div", "empty-state", "ตะกร้าว่าง: กด \"ใส่ตะกร้า\" ที่สินค้า"));
    for (const item of basket) {
      const p = basketProducts.get(item.id);
      if (!p) continue;
      const { size } = unitOf(p);
      const row = el("div", "cart-row");
      const info = el("div", "cart-info");
      info.append(el("b", "", p.label), el("span", "muted", `${num(p.latest_price / size, 2)} ฿/${unitOf(p).unit}`));
      const remove = el("button", "remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `เอา${p.label}ออกจากตะกร้า`);
      remove.addEventListener("click", () => setBasketQty(item.id, 0));
      const photo = productPhoto(p.label);
      row.append(photo ? photoImg(photo, "cart-thumb") : plate(productLook(p.label).icon), info, remove, stepper(p, item, { compact: true }), el("div", "line-total", bahtPrice((item.qty / size) * p.latest_price)));
      list.appendChild(row);
    }

    const t = basketTotals();
    const diff = t.now - t.yearAgo;
    const diffPct = t.yearAgo ? (diff / t.yearAgo) * 100 : 0;
    const totals = $("cart-totals");
    totals.replaceChildren();
    if (basket.length) {
      const line = (label, value, cls = "") => { const row = el("div", `cart-line ${cls}`.trim()); row.append(el("span", "", label), value); return row; };
      const was = el("s", "", wholeBaht(t.yearAgo));
      totals.append(
        line("ถ้าซื้อเมื่อปีก่อน", was, "muted-line"),
        line(`ราคาวันนี้ (${basket.length} รายการ)`, el("b", "cart-total", wholeBaht(t.now)), "total-line"),
      );
      const change = el("div", "cart-change");
      change.append(deltaNode(diffPct, "% จากปีก่อน"), el("span", "", `${diff >= 0 ? "จ่ายเพิ่ม" : "จ่ายน้อยลง"} ${wholeBaht(Math.abs(diff))}`));
      const ai = el("div", "cart-ai");
      ai.append(aiLabel(`AI ทายเฉลี่ยทั้งเดือน ${t.target ? thMonth(t.target) : "หน้า"}`), el("b", "", `≈ ${wholeBaht(t.next)}`));
      totals.append(change, ai);
    }
    $("cart-summary").disabled = !basket.length;
    $("cart-bar-text").textContent = basket.length ? `${basket.length} รายการ · ${wholeBaht(t.now)}` : "ตะกร้าว่าง";
    $("basket-takeaway").textContent = basket.length
      ? `ของ ${basket.length} อย่างในตะกร้า วันนี้ ${wholeBaht(t.now)} ${diff >= 0 ? "แพงขึ้น" : "ถูกลง"} ${wholeBaht(Math.abs(diff))} จากปีก่อน (${pct(diffPct, 1)})`
      : "เลือกของที่ซื้อประจำใส่ตะกร้า แล้วดูว่าแพงขึ้นจากปีก่อนกี่บาท และ AI คาดว่าเดือนหน้าจะจ่ายเท่าไหร่";
  }

  // ใบสรุปค่าใช้จ่าย (แทนปุ่มชำระเงิน: เว็บนี้ไม่ได้ขายของจริง)
  function openSummary() {
    const t = basketTotals();
    const diff = t.now - t.yearAgo;
    const body = $("summary-body");
    body.replaceChildren();
    const receipt = el("div", "receipt summary-receipt");
    receipt.append(el("div", "receipt-kicker", `ราคา ณ ${t.latest ? thDay(t.latest) : "วันนี้"}`), el("div", "receipt-rule"));
    for (const item of basket) {
      const p = basketProducts.get(item.id);
      if (!p) continue;
      const row = el("div", "receipt-row");
      row.append(el("span", "", `${p.label} × ${fmtQty(item.qty)} ${unitOf(p).unit}`), el("span", "receipt-cost", num((item.qty / unitOf(p).size) * p.latest_price, 2)));
      receipt.appendChild(row);
    }
    const total = el("div", "receipt-row receipt-total");
    total.append(el("span", "", "รวมวันนี้"), el("span", "receipt-cost", wholeBaht(t.now)));
    receipt.append(el("div", "receipt-rule"), total);
    const compare = el("div", "summary-compare");
    const year = tile(compare, { label: "ถ้าซื้อชุดเดียวกันเมื่อปีก่อน", value: wholeBaht(t.yearAgo), icon: "calendar" });
    year.append(deltaNode(t.yearAgo ? (diff / t.yearAgo) * 100 : 0, "% จากปีก่อน"), el("div", "sub", `วันนี้${diff >= 0 ? "จ่ายเพิ่ม" : "จ่ายน้อยลง"} ${wholeBaht(Math.abs(diff))}${t.missingYear ? ` · ${t.missingYear} รายการไม่มีราคาปีก่อน นับเท่าเดิม` : ""}`));
    const ai = el("article", "ai-card summary-ai");
    const aiChange = t.base ? ((t.next - t.base) / t.base) * 100 : 0;
    const aiValue = el("div", "ai-value");
    aiValue.append(document.createTextNode("≈ "), el("b", "", wholeBaht(t.next)));
    ai.append(aiLabel(`AI ทายเฉลี่ยทั้งเดือน ${t.target ? thMonth(t.target) : "หน้า"}`), aiValue,
      el("div", "muted", `เฉลี่ย ${t.basePeriod ? thMonth(t.basePeriod) : "เดือนก่อน"} ${wholeBaht(t.base)} → ${moveText(aiChange, 1)}${t.missingAi ? ` · ${t.missingAi} รายการไม่มีค่าทาย นับเท่าเดิม` : ""}`));
    compare.appendChild(ai);
    body.append(receipt, compare);
    const dialog = $("summary-dialog");
    if (!dialog.open) dialog.showModal();
    basketChartDrawn = false;
    drawBasketChart();
  }

  // บนมือถือ ตะกร้าเป็นแผ่นเลื่อนขึ้นจากล่าง
  const setCartOpen = (open) => {
    $("cart").classList.toggle("open", open);
    $("cart-backdrop").hidden = !open;
    document.body.classList.toggle("sheet-open", open);
    if (open) $("cart-close").focus();
  };

  async function renderBasketPage() {
    const products = await pricesP();
    basketProducts = new Map(products.map((p) => [p.product_id, p]));
    basket = basket.filter((i) => basketProducts.has(i.id));
    if (!$("shop-groups").children.length) {
      const groups = [...new Set(products.map((p) => p.product_group).filter(Boolean))];
      const chips = $("shop-groups");
      for (const [value, label] of [["", "ทั้งหมด"], ...groups.map((g) => [g, GROUP_LABELS[g] || g])]) {
        const button = el("button", value === shop.group ? "active" : "", label);
        button.type = "button";
        button.dataset.group = value;
        chips.appendChild(button);
      }
      chips.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-group]");
        if (!button) return;
        shop.group = button.dataset.group;
        shop.limit = SHOP_PAGE;
        chips.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === button));
        drawShop();
      });
      $("shop-search").addEventListener("input", (event) => { shop.query = event.target.value; shop.limit = SHOP_PAGE; drawShop(); });
      picker($("shop-sort"));
      $("shop-sort").addEventListener("change", () => { shop.sort = $("shop-sort").value; drawShop(); });
      $("shop-more").addEventListener("click", () => { shop.limit += SHOP_PAGE; drawShop(); });
      $("basket-reset").addEventListener("click", () => { basket = DEFAULT_BASKET.map((i) => ({ ...i })); saveBasket(); drawShop(); drawCart(); });
      $("basket-clear").addEventListener("click", () => { basket = []; saveBasket(); drawShop(); drawCart(); });
      $("cart-summary").addEventListener("click", openSummary);
      $("summary-close").addEventListener("click", () => $("summary-dialog").close());
      $("summary-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
      $("cart-bar").addEventListener("click", () => setCartOpen(true));
      $("cart-close").addEventListener("click", () => setCartOpen(false));
      $("cart-backdrop").addEventListener("click", () => setCartOpen(false));
      document.addEventListener("keydown", (event) => { if (event.key === "Escape" && $("cart").classList.contains("open")) setCartOpen(false); });
    }
    saveBasket();
    drawShop();
    drawCart();
  }

  // ยอดรวมของตะกร้านี้ย้อนหลังรายเดือน (เฉพาะเดือนที่มีราคาครบทุกรายการ) + จุดที่ AI ทาย
  async function drawBasketChart() {
    const container = $("chart-basket");
    const items = basket.filter((i) => i.qty > 0);
    if (!items.length) { container.replaceChildren(el("div", "empty-state", "ใส่ของในตะกร้าก่อน")); return; }
    const key = items.map((i) => i.id).sort().join(",");
    try {
      if (!basketHistory || basketHistory.key !== key) basketHistory = { key, data: await api(`/api/basket/history?ids=${key}`) };
      const { periods, prices } = basketHistory.data;
      const points = [];
      periods.forEach((period, index) => {
        let total = 0;
        for (const item of items) {
          const price = prices[item.id]?.[index];
          if (price == null) return;
          total += (item.qty / unitOf(basketProducts.get(item.id)).size) * price;
        }
        points.push([parseDate(period), total]);
      });
      const t = basketTotals();
      const series = [{ name: "ยอดตะกร้าจริง (ราคาเฉลี่ยรายเดือน)", color: cssVar("--actual"), area: true, areaOpacity: 0.1, endLabel: false, points: points.filter((p) => !t.target || p[0] < parseDate(t.target)) }];
      if (t.target && t.basePeriod) {
        series.push({ name: "ที่ AI ทาย", color: cssVar("--ai"), dashed: true, endLabel: false, points: [[parseDate(t.basePeriod), t.base], [parseDate(t.target), t.next]] });
      }
      const skipped = periods.length - points.length;
      $("basket-chart-sub").textContent = `ราคาเฉลี่ยจริงแต่ละเดือน × จำนวนในตะกร้าตอนนี้${skipped ? ` · ข้าม ${skipped} เดือนที่บางรายการไม่มีราคา` : ""}`;
      line(container, {
        series, forceLegend: true, height: 260, ariaLabel: "ยอดตะกร้าย้อนหลังรายเดือน", animate: basketChartDrawn ? false : undefined,
        yFormat: (v, isAxis) => (isAxis ? num(v, 0) : bahtPrice(v)),
      });
      basketChartDrawn = true;
    } catch (error) { showError(container, error); }
  }

  // ---------- หน้า 6: เบื้องหลังระบบ ----------
  const SOURCE_NAMES = {
    tpso_cpig: "สนค. CPI ประเทศ/ภาค", tpso_cpip: "สนค. CPI จังหวัด", moc_retail_prices: "กรมการค้าภายใน API",
    mol_minimum_wage: "กระทรวงแรงงาน ค่าจ้างขั้นต่ำ", dld_farm_prices: "กรมปศุสัตว์ ราคาหน้าฟาร์ม",
    moc_web_meat_seafood: "Scraping: เนื้อสัตว์/สัตว์น้ำ", moc_web_vegetables_fruit: "Scraping: ผัก/ผลไม้",
    moc_web_pantry_rice: "Scraping: ของแห้ง/ข้าวสาร",
  };
  function renderFlow(tables) {
    const rows = (name) => compact(tables.find((t) => t.name === name)?.rows ?? 0);
    const steps = [
      { icon: "database", title: "1. ดึงข้อมูล (Extract)", text: `API ของ สนค. (${rows("cpi_monthly")} แถว) · Web scraping ราคาจริงกรมการค้าภายใน (${rows("retail_prices_daily")} แถว) · CSV จาก data.go.th · PDF ประกาศค่าแรง` },
      { icon: "target", title: "2. ตรวจคุณภาพ (Validate)", text: "ต้องมี ≥ 1 ล้านแถว, ครบ 70+ จังหวัด, ค่าผิดปกติ ≤ 0.1% · ถ้าไม่ผ่าน BranchPythonOperator จะไปแจ้งเตือนแทน" },
      { icon: "layers", title: "3. แปลงข้อมูล (Transform)", text: `สรุปรายปี, ราคาเฉลี่ยรายเดือน (${rows("retail_price_monthly")} แถว), ค่าแรงเมื่อหักของแพง, correlation ด้วย SQL ใน PostgreSQL` },
      { icon: "sparkle", title: "4. เทรนโมเดล (ML)", text: `HistGradientBoosting · เทียบ baseline และโมเดลเดิมก่อน deploy · พยากรณ์ ${rows("cpi_forecasts")} series` },
      { icon: "chart", title: "5. แสดงผล (Serve)", text: "FastAPI + เว็บนี้ อ่านข้อมูลสดจาก PostgreSQL · ไฟล์ Excel/CSV สำหรับ Power BI" },
    ];
    const flow = $("flow");
    flow.replaceChildren();
    for (const step of steps) {
      const item = el("li", "flow-step");
      const body = el("div");
      body.append(el("b", "", step.title), el("div", "muted", step.text));
      item.append(plate(step.icon), body);
      flow.appendChild(item);
    }
  }

  async function renderModelQuality() {
    const metrics = await metricsP();
    const tiles = $("model-tiles");
    tiles.replaceChildren();
    const champion = championOf(metrics);
    if (!champion) { tiles.appendChild(el("div", "empty-state", "ยังไม่มีผลการเทรน")); return; }
    const gain = (1 - champion.rmse / champion.baseline_rmse) * 100;
    tile(tiles, { label: "RMSE โมเดล", value: num(champion.rmse, 3), sub: `MAE ${num(champion.mae, 3)} (% ต่อเดือน) ยิ่งต่ำยิ่งดี`, icon: "target", tone: "purple" });
    tile(tiles, { label: "RMSE baseline (เดาว่าเท่าเดิม)", value: num(champion.baseline_rmse, 3), sub: `โมเดลดีกว่า ${num(gain, 1)}%`, icon: "equal", tone: "blue" });
    tile(tiles, { label: "Direction accuracy", value: `${num(champion.direction_accuracy * 100, 1)}%`, sub: "ทายทิศทางขึ้น/ลงถูก (เดือนที่ราคาเปลี่ยนจริง)", icon: "updown", tone: "pink" });
    tile(tiles, { label: "Training rows", value: compact(champion.training_rows), sub: `Holdout ${compact(champion.holdout_rows)} แถว · R² ${num(champion.r2, 3)}`, icon: "database", tone: "teal" });
    tableRows($("model-table"), [
      { label: "รอบที่เทรน" }, { label: "RMSE", num: true }, { label: "Baseline", num: true }, { label: "R²", num: true }, { label: "ทิศทางถูก", num: true }, { label: "ผล" },
    ], [...metrics].reverse().map((m) => ({
      cells: [new Date(m.run_at).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }), num(m.rmse, 3), num(m.baseline_rmse, 3), num(m.r2, 3), `${num(m.direction_accuracy * 100, 1)}%`, m.deployed ? "Deploy (Champion)" : "Skip (ไม่ดีกว่าเดิม)"],
    })));
  }

  async function renderDataPage() {
    const [pipelineInfo, summary] = await Promise.all([once("pipeline", () => api("/api/pipeline")), summaryP()]);
    renderFlow(pipelineInfo.tables);
    renderLongrun();
    const tiles = $("data-tiles");
    tiles.replaceChildren();
    const v = summary.volume;
    // รวมแถวของทุกตารางที่เว็บนี้ใช้ (ดัชนี ราคาจริง ค่าแรง ผลพยากรณ์ ฯลฯ)
    const totalRows = pipelineInfo.tables.reduce((sum, t) => sum + Number(t.rows), 0);
    const tableRowsOf = (name) => Number((pipelineInfo.tables.find((t) => t.name === name) || {}).rows || 0);
    const totalTile = tile(tiles, { label: "ข้อมูลทั้งหมดบนเว็บ", value: `${num(totalRows / 1e6, 2)} ล้านแถว`, sub: `${compact(totalRows)} แถว จาก ${pipelineInfo.tables.length} ตาราง · ดัชนีราคา ${num(tableRowsOf("cpi_monthly") / 1e6, 2)} ล้าน · ราคาขายปลีกรายวัน ${compact(tableRowsOf("retail_prices_daily"))}`, icon: "database", tone: "teal" });
    countUp(totalTile.querySelector(".value"), totalRows / 1e6, { format: (x) => `${num(x, 2)} ล้านแถว` });
    // สนค. ไม่แยกดัชนีกรุงเทพฯ รายจังหวัด กทม. จึงใช้ดัชนี "กรุงเทพฯ และปริมณฑล" จากชุดข้อมูลภาค (+1)
    tile(tiles, { label: "พื้นที่", value: `${v.provinces + 1} จังหวัด`, sub: `${v.provinces} จังหวัด + กทม. (ใช้ดัชนี กทม.และปริมณฑล) · ทั้งประเทศและ 5 ภาค`, icon: "pin", tone: "pink" });
    tile(tiles, { label: "หมวดสินค้า", value: `${compact(v.commodities)} หมวด`, sub: `หมวดหลัก ${v.commodities_l1} · หมวดรอง ${v.commodities_l2} · หมวดย่อย ${v.commodities_l3} · มีราคาจริงเป็นบาท ${compact(v.products)} สินค้า`, icon: "layers", tone: "purple" });
    tile(tiles, { label: "ข้อมูลย้อนหลังถึง", value: thMonth(v.first_period), icon: "calendar", tone: "amber", sub: `โหลดล่าสุด ${new Date(v.last_loaded).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}` });
    bars($("table-counts"), pipelineInfo.tables.map((t) => ({ label: t.name, value: t.rows, color: cssVar("--series-1") })), { format: (x) => compact(x), valueLabel: "แถว" });
    tableRows($("load-table"), [{ label: "แหล่งข้อมูล" }, { label: "แถว", num: true }, { label: "เวลา" }],
      pipelineInfo.loads.map((l) => ({ cells: [SOURCE_NAMES[l.source] || l.source, compact(l.rows_loaded), new Date(l.loaded_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })] })));
    renderPowerBi();
    renderDownloads();
    await renderModelQuality();
    bars($("farm-corr"), pipelineInfo.farm_correlations.slice(0, 10).map((c) => ({
      label: `${c.farm_item.replace(/ราคา|ที่เกษตรกรขายได้|รายเดือน|เฉลี่ย/g, "").trim()} · lag ${c.lag_months}`,
      value: c.pearson_correlation,
      color: cssVar("--series-3"),
      extra: [{ label: "จำนวนเดือน", value: String(c.sample_size) }],
    })), { format: (x) => num(x, 2), valueLabel: "r" });
  }

  // รายงาน Power BI ฝังด้วย iframe ถ้าตั้ง POWERBI_EMBED_URL ไว้ ไม่งั้นบอกวิธีตั้งค่า
  async function renderPowerBi() {
    const box = $("powerbi");
    if (box.dataset.done) return;
    box.dataset.done = "1";
    const { embed_url: url } = await api("/api/powerbi");
    if (!url) {
      const note = document.createElement("p");
      note.className = "powerbi-empty";
      note.innerHTML = "ยังไม่ได้ใส่ลิงก์รายงาน · สร้างรายงานใน Power BI แล้วใช้ <b>File → Embed report</b> คัดลอกลิงก์มาใส่ <code>POWERBI_EMBED_URL</code> ในไฟล์ <code>.env</code> (ดู docs/powerbi_guide.md)";
      box.replaceChildren(note);
      return;
    }
    const frame = document.createElement("iframe");
    frame.title = "รายงาน Power BI ค่าครองชีพไทย";
    frame.src = url;
    frame.loading = "lazy";
    frame.allowFullscreen = true;
    box.replaceChildren(frame);
    const open = $("powerbi-open");
    open.href = url;
    open.hidden = false;
  }

  // ปุ่มดาวน์โหลด Excel แสดงขนาดและเวลาที่สร้าง เพราะไฟล์เต็มอาจใหญ่หลายสิบ MB
  async function renderDownloads() {
    const box = $("downloads");
    if (box.dataset.done) return;
    box.dataset.done = "1";
    const { files } = await api("/api/downloads");
    if (!files.length) {
      const note = document.createElement("p");
      note.className = "powerbi-empty";
      note.textContent = "ยังไม่มีไฟล์ · รัน DAG ใน Airflow ให้ถึง task export_powerbi ก่อน แล้วไฟล์จะขึ้นที่นี่";
      box.replaceChildren(note);
      return;
    }
    box.replaceChildren(...files.map((f) => {
      const row = document.createElement("div");
      row.className = "download-row";
      const text = document.createElement("div");
      const title = document.createElement("b");
      title.textContent = f.label;
      const sub = document.createElement("p");
      sub.className = "muted";
      const when = new Date(f.generated_at).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
      sub.textContent = `${f.description} · ${num(f.bytes / 1e6, 1)} MB · สร้างเมื่อ ${when}`;
      text.append(title, sub);
      const link = document.createElement("a");
      link.className = "link-btn";
      link.href = f.url;
      link.download = f.file;
      link.textContent = "ดาวน์โหลด .xlsx";
      row.append(text, link);
      return row;
    }));
  }

  // ---------- router ----------
  const PAGES = { overview: renderOverview, map: renderMapPage, forecast: renderForecastPage, wage: renderWagePage, basket: renderBasketPage, data: renderDataPage };
  async function route() {
    const page = (location.hash || "#overview").slice(1);
    // #prices (ลิงก์เดิม/จากหน้าพยากรณ์) = ส่วนราคาของกินในหน้าแรก
    const name = page === "prices" ? "overview" : PAGES[page] ? page : "overview";
    for (const key of Object.keys(PAGES)) {
      const section = $(`page-${key}`);
      const entering = key === name && section.hidden;
      section.hidden = key !== name;
      if (entering) { section.classList.remove("page-enter"); void section.offsetWidth; section.classList.add("page-enter"); }
    }
    document.querySelectorAll(".nav a").forEach((link) => link.classList.toggle("active", link.dataset.page === name));
    if (page !== "prices") window.scrollTo({ top: 0 });
    try {
      await PAGES[name]();
      if (page === "prices") await showPriceDetail();
    } catch (error) { console.error(error); showError($(`page-${name}`).querySelector(".card") || $(`page-${name}`), error); }
  }
  $("range-chips").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-years]");
    if (!button) return;
    longrunYears = Number(button.dataset.years);
    document.querySelectorAll("#range-chips button").forEach((b) => b.classList.toggle("active", b === button));
    renderLongrun();
  });
  // ปุ่มดาวน์โหลดบนแถบเมนู: เช็กก่อนว่ามีไฟล์ ไม่งั้นกดแล้วจะเจอหน้า 404
  $("nav-download").addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      const { files } = await api("/api/downloads");
      const file = files.find((f) => f.key === "excel");
      if (file) { window.location.href = file.url; return; }
    } catch (error) { console.error(error); }
    alert("ยังไม่มีไฟล์ Excel · ต้องรัน DAG ใน Airflow ให้ถึง task export_powerbi ก่อน");
  });
  hydrate();
  prepareReveal();
  saveBasket();
  window.addEventListener("hashchange", route);
  summaryP().then((s) => {
    if (location.hash && location.hash !== "#overview") {
      $("freshness").textContent = `ข้อมูลถึง ${thMonth(s.latest_period)}`;
    }
  }).catch(() => {});
  route();
})();
