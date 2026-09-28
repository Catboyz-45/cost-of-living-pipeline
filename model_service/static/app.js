/* ตัวควบคุมหน้า dashboard: โหลดข้อมูลจาก API แล้ววาดด้วย charts.js
 * แต่ละหน้าโหลดครั้งแรกเมื่อถูกเปิด (lazy) และเก็บ cache ไว้ใช้ซ้ำ
 * ข้อความบนหน้าเขียนเป็นภาษาคนทั่วไป ศัพท์เทคนิคอยู่ในหน้า "เบื้องหลังระบบ"
 */
(function () {
  const { line, bars, map, sparkline, divergingLegend, cssVar, monthLabel } = window.Charts;
  const { plate, hydrate } = window.Icons;
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
  const commodityOptions = (list) => list
    .filter((c) => isEverydayCategory(c.commodity_code))
    .map((c) => ({ value: c.commodity_code, label: `${"   ".repeat(c.level - 1)}${plainName(c.commodity_code, c.commodity_name)}` }));
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
  let priceLimit = PAGE_SIZE;
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

  function priceCard(container, product) {
    const look = productLook(product.label);
    const card = el("button", `price-card tone-${look.tone}`);
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
    card.append(spark, el("div", "muted", `ราคาวันที่ ${thDay(product.price_date)}`));
    card.addEventListener("click", () => {
      selectedProduct = product;
      drawPrice();
      $("price-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    container.appendChild(card);
    // วาดเส้นหลังใส่การ์ดลงหน้าแล้ว เพื่อให้อ่านสีโทนของการ์ดได้
    if (product.spark && product.spark.length > 1) sparkline(spark, product.spark, { height: 32 });
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
      $("price-more").addEventListener("click", () => { priceLimit += PAGE_SIZE; drawPriceGrid(products); });
    }
    drawPriceGrid(products);
    if (!selectedProduct) selectedProduct = products.find((p) => p.product_id === STAPLES[0]) || products[0] || null;
    await drawPrice();
    return products;
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
    $("price-count").textContent = products.length
      ? `ราคาจริงจากกรมการค้าภายใน ${compact(products.length)} รายการ · สำรวจล่าสุด ${thDay(latest)} · แสดง ${compact(Math.min(matched.length, priceLimit))} จาก ${compact(matched.length)} ที่ตรงเงื่อนไข`
      : "";
    $("price-more").hidden = matched.length <= priceLimit;
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
      const color = cssVar("--series-1");
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
    const prev = (list) => list[list.length - 2] || {};
    const inflation = last(headline).yoy;

    document.querySelectorAll("[data-latest]").forEach((node) => { node.textContent = thMonth(latest); });
    const hero = $("hero");
    hero.replaceChildren();
    const heroHead = el("div", "tile-head");
    const heroLabel = el("div", "label", `ของโดยรวม ${thMonth(latest)} เทียบกับปีก่อน `);
    const info = el("button", "info", "i");
    info.type = "button";
    info.dataset.tip = "นี่คือตัวเลข \"เงินเฟ้อ\" ที่ข่าวพูดถึง: ราคาของโดยรวมเทียบกับเดือนเดียวกันของปีก่อน คิดจากสินค้าและบริการหลายร้อยรายการที่คนไทยซื้อจริง ข้อมูลจาก สนค. กระทรวงพาณิชย์";
    heroLabel.appendChild(info);
    heroHead.append(plate("trend"), heroLabel);
    hero.append(heroHead, el("div", "value", moveText(inflation)));
    hero.appendChild(moneyLine("ของที่ปีก่อนจ่าย ", "100 บาท", " ตอนนี้ต้องจ่าย ", `${num(100 + inflation, 2)} บาท`));
    const spark = el("div", "spark");
    hero.appendChild(spark);
    sparkline(spark, headline.map((p) => p.yoy), { includeZero: true });
    hero.appendChild(el("div", "muted", `เส้น: ย้อนหลัง 24 เดือน · เดือนก่อน${moveText(prev(headline).yoy)}`));

    const tiles = $("overview-tiles");
    tiles.replaceChildren();
    // สีเส้นเล็กตรงกับสีของหมวดเดียวกันในกราฟย้อนหลังหลายปี (อาหาร = series-2, พลังงาน = series-3)
    tile(tiles, {
      label: "ค่าอาหารและเครื่องดื่ม", value: pct(last(food).yoy), sub: `จากปีก่อน · ของ 100 บาท ตอนนี้ ${num(100 + last(food).yoy, 2)} บาท`,
      icon: "bowl", tone: "orange", spark: (holder) => sparkline(holder, food.map((p) => p.yoy), { color: cssVar("--series-2"), height: 36, includeZero: true }),
    });
    tile(tiles, {
      label: "ค่าน้ำมัน ไฟ แก๊ส", value: pct(last(energy).yoy), sub: `จากปีก่อน · ของ 100 บาท ตอนนี้ ${num(100 + last(energy).yoy, 2)} บาท`,
      icon: "bolt", tone: "green", spark: (holder) => sparkline(holder, energy.map((p) => p.yoy), { color: cssVar("--series-3"), height: 36, includeZero: true }),
    });
    const fuelTile = tile(tiles, { label: "น้ำมันแก๊สโซฮอล์ 95 วันนี้", value: "–", sub: "ราคาหน้าปั๊ม กรุงเทพฯ (ปตท.)", icon: "fuel", tone: "blue" });
    const wage = summary.bangkok_wage;
    const wageTile = tile(tiles, {
      label: "ค่าแรงขั้นต่ำ กรุงเทพฯ",
      value: wage ? `${num(wage.latest.nominal_wage, 0)} ฿/วัน` : "–",
      sub: "ค่าแรง 1 วัน", icon: "wallet", tone: "teal",
    });

    const volume = summary.volume;
    $("freshness").replaceChildren(
      document.createTextNode("ข้อมูลถึง "), el("b", "", thMonth(latest)), el("br"),
      el("b", "", compact(volume.cpi_rows)), document.createTextNode(" แถวดัชนี · "),
      el("b", "", String(volume.provinces + 1)), document.createTextNode(" จังหวัด"),
    );

    const [products, categories] = await Promise.all([
      renderPriceExplorer(),
      once("cat2", () => api("/api/categories/yoy?level=2")),
    ]);
    const egg = products.find((p) => p.product_id === "P11028");
    if (wage && egg) wageTile.querySelector(".sub").textContent = `ซื้อไข่ไก่ได้วันละ ${num(wage.latest.nominal_wage / egg.latest_price, 0)} ฟอง`;
    const fuel = products.find((p) => p.product_id === "F52002");
    if (fuel) {
      fuelTile.querySelector(".value").textContent = `${bahtPrice(fuel.latest_price)}/ลิตร`;
      const yoy = yoyPct(fuel);
      if (yoy !== null) fuelTile.insertBefore(deltaNode(yoy, "% จากปีก่อน"), fuelTile.querySelector(".sub"));
    }
    renderAiBanner(summary.forecast["00000"], products);

    // หมวดค่าใช้จ่ายจริงเท่านั้น (ตัดกลุ่มสำหรับนักวิเคราะห์) เรียงจากแพงขึ้นมากสุด
    const everyday = categories.items.filter((item) => isEverydayCategory(item.commodity_code) && item.change_yoy !== null);
    $("category-sub").textContent = `ทั้งประเทศ · ${categories.period ? thMonth(categories.period) : ""} เทียบกับเดือนเดียวกันของปีก่อน · แดง = แพงขึ้น ฟ้า = ถูกลง`;
    bars($("chart-categories"), everyday.map((item) => ({
      label: plainName(item.commodity_code, item.commodity_name),
      value: item.change_yoy,
      extra: [{ label: "จากเดือนก่อน", value: pct(item.change_mom) }],
    })), { format: (v) => pct(v), valueLabel: "จากปีก่อน" });

    // ประโยคสรุปบนสุดของหน้า
    const staples = STAPLES.map((id) => products.find((p) => p.product_id === id)).filter((p) => p && yoyPct(p) !== null);
    const sortedStaples = [...staples].sort((a, b) => yoyPct(b) - yoyPct(a));
    const parts = [`ของโดยรวม${moveText(inflation)} จากปีก่อน — ของที่ปีก่อนจ่าย 100 บาท ตอนนี้ต้องจ่าย ${num(100 + inflation, 2)} บาท`];
    if (everyday[0]) parts.push(`เรื่องที่แพงขึ้นมากที่สุดคือ${plainName(everyday[0].commodity_code, everyday[0].commodity_name)} (${pct(everyday[0].change_yoy, 1)})`);
    if (sortedStaples.length) {
      const up = sortedStaples[0], down = sortedStaples[sortedStaples.length - 1];
      parts.push(`ของกินพื้นฐาน: ${up.label}${moveText(yoyPct(up), 0)}${yoyPct(down) < 0 ? ` ส่วน${down.label}${moveText(yoyPct(down), 0)}` : ""}`);
    }
    $("overview-takeaway").textContent = `${parts.join(" · ")}`;

    await renderLongrun();
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

  // ---------- หน้า 2: จังหวัดไหนแพงเร็ว ----------
  let mapHandle = null;
  let mapSelected = null;
  async function renderMapPage() {
    const [commodities, geo] = await Promise.all([
      commoditiesP(),
      once("geo", () => api("/static/thailand_provinces.geojson")),
    ]);
    const select = $("map-commodity");
    if (!select.options.length) {
      fillSelect(select, commodityOptions(commodities), "00000");
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

    if (ranked.length) {
      const top = ranked[0], bottom = ranked[ranked.length - 1];
      $("map-takeaway").textContent = `${topic} (${thMonth(data.period)}): ${top.name}${moveText(top.yoy)} จากปีก่อน เร็วที่สุดใน ${ranked.length} จังหวัด ส่วน${bottom.name}${moveText(bottom.yoy)} · สีแดงเข้ม = แพงขึ้นเร็ว สีฟ้า = ถูกลง`;
    }
  }

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
    const banner = $("ai-banner");
    banner.replaceChildren();
    if (!fc) { banner.hidden = true; return; }
    const body = el("div", "ai-body");
    body.append(
      el("div", "ai-label", `AI คาดว่าเดือน ${thMonth(fc.target_period)}`),
      el("div", "ai-value", `ของโดยรวมจะ${moveText(fc.predicted_change_pct)}`),
    );
    const chips = el("div", "ai-chips");
    for (const id of ["P11028", "P11003", "F52002"]) {
      const product = products.find((p) => p.product_id === id);
      if (!product || !product.next_month_price) continue;
      const chip = el("span", "ai-chip");
      chip.append(document.createTextNode(`${product.label} ≈ `), el("b", "", bahtPrice(product.next_month_price)), document.createTextNode(perUnit(product.unit)));
      chips.appendChild(chip);
    }
    body.appendChild(chips);
    banner.append(plate("sparkle"), body, el("span", "ai-cta", "ดูที่ AI ทาย →"));
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
      const color = cssVar("--series-1");
      const series = [{ name: "ราคาจริง (เฉลี่ยรายเดือน)", color, area: true, endLabel: false, points: data.monthly.map((m) => [parseDate(m.period_date), m.avg_price]) }];
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
    const big = el("div", "big", `${bahtPrice(predicted)}`);
    big.appendChild(el("span", "per", perUnit(product.unit)));
    const move = el("div", "badge-change", `${moveText(change)} จาก ${thMonth(product.base_period)}`);
    move.style.color = changeColor(change);
    badge.append(el("div", "muted", `AI ทายราคาเฉลี่ย ${thMonth(product.target_period)}`), big, move);
    if (product.target_month_actual) {
      badge.appendChild(el("div", "muted", `ราคาจริง ${thMonth(product.target_period)} (${product.target_month_days} วันที่สำรวจแล้ว) ≈ ${bahtPrice(product.target_month_actual)}`));
    }
    badge.appendChild(el("div", "muted", note));
  }

  async function predictLive() {
    const button = $("fc-live");
    if (!fcCurrent) return;
    button.disabled = true;
    button.textContent = "AI กำลังคิด…";
    try {
      const p = await api("/api/predict", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area_key: "region:10", commodity_code: fcCurrent.cpi_code }),
      });
      renderForecastBadge(fcCurrent, p.predicted_change_pct, "ทายใหม่เมื่อสักครู่");
    } catch (error) {
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
    $("fc-bt-sub").textContent = `AI เรียนจากข้อมูลถึง ${thMonth(s.trained_through)} แล้วทายทีละเดือน ${s.months} เดือนหลังจากนั้น (${thMonth(rows[0].target_period)} – ${thMonth(rows[rows.length - 1].target_period)}) ซึ่ง AI ไม่เคยเห็นมาก่อน · AI ทาย % ของหมวด "${categoryName(data.product.cpi_code)}" แล้วคูณกับราคาเดือนก่อนของสินค้านี้`;
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
        { name: "ราคาจริง", color: cssVar("--series-1"), points: rows.map((r) => [parseDate(r.target_period), r.actual_price]) },
        { name: "AI ทายไว้ล่วงหน้า 1 เดือน", color: cssVar("--forecast"), dashed: true, points: rows.map((r) => [parseDate(r.target_period), r.predicted_price]) },
      ],
    });
  }

  function productRow(container, product) {
    const look = productLook(product.label);
    const row = el("button", `pf-row tone-${look.tone}`);
    row.type = "button";
    const name = el("div", "pf-name");
    name.append(el("b", "", product.label), el("span", "muted", `${categoryName(product.cpi_code)} · ${product.unit}`));
    const next = el("div", "pf-next", bahtPrice(product.next_month_price));
    next.style.color = changeColor(product.predicted_change_pct);
    row.append(plate(look.icon), name, el("div", "pf-now", bahtPrice(product.base_month_price)), el("div", "pf-arrow", "→"), next, el("div", "pf-chg", pct(product.predicted_change_pct)));
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
        const text = `ราคาเฉลี่ย ${thMonth(sample.base_period)} → ที่ AI ทายสำหรับ ${thMonth(sample.target_period)} · กดเพื่อดูกราฟ`;
        $("fc-rising-sub").textContent = text;
        $("fc-falling-sub").textContent = text;
      }
      const fc = summary.forecast["00000"];
      const parts = [];
      if (fc) parts.push(`AI คาดว่าเดือน ${thMonth(fc.target_period)} ของโดยรวมจะ${moveText(fc.predicted_change_pct)} จากเดือนก่อน`);
      const up = data.rising[0], down = data.falling[0];
      if (up) parts.push(`ของที่น่าจะแพงขึ้น เช่น ${up.label} ≈ ${bahtPrice(up.next_month_price)}${perUnit(up.unit)} (${pct(up.predicted_change_pct, 1)})`);
      if (down) parts.push(`ที่น่าจะถูกลง เช่น ${down.label} ≈ ${bahtPrice(down.next_month_price)}${perUnit(down.unit)} (${pct(down.predicted_change_pct, 1)})`);
      $("fc-takeaway").textContent = parts.join(" · ");
    } catch (error) { showError($("fc-rising"), error); }
  }

  const championOf = (metrics) => [...metrics].reverse().find((m) => m.deployed) || metrics[metrics.length - 1];
  async function renderForecastAccuracy() {
    try {
      const champion = championOf(await metricsP());
      if (!champion) return;
      const gain = (1 - champion.rmse / champion.baseline_rmse) * 100;
      $("fc-accuracy").textContent = `ควรรู้: AI ตัวนี้ใช้ดูแนวโน้มว่าราคาน่าจะขึ้นหรือลง ไม่ได้ทายราคาได้เป๊ะ · ทดสอบกับทุกหมวดทุกพื้นที่ช่วง 12 เดือนที่ไม่เคยเห็น ทายพลาดเฉลี่ยประมาณ ±${num(champion.mae, 1)}% ต่อเดือน ทายทิศทางถูก ${num(champion.direction_accuracy * 100, 0)}% และแม่นกว่าการเดาว่า "ราคาเท่าเดิม" ${num(gain, 0)}% · ราคาจริงมาจากตลาดและปั๊มในกรุงเทพฯ · รายละเอียดทางเทคนิคอยู่ในหน้าเบื้องหลังระบบ`;
    } catch (error) { $("fc-accuracy").textContent = ""; }
  }

  // ---------- หน้า 4: ค่าแรงพอไหม ----------
  async function renderWagePage() {
    const provinces = await once("wage-prov", () => api("/api/wage/provinces"));
    const select = $("wage-province");
    if (!select.options.length) {
      const sorted = [...provinces].sort((a, b) => a.province_name.localeCompare(b.province_name, "th"));
      fillSelect(select, sorted.map((p) => ({ value: p.province_code, label: p.province_name })), "10");
      select.addEventListener("change", drawWage);
    }
    await drawWage();
    const first = provinces[0];
    $("wage-table-sub").textContent = first
      ? `ค่าแรงเดือนล่าสุด (${thMonth(first.last_period)}) · "ซื้อของได้" เทียบกับเดือนแรกที่มีข้อมูล (${thMonth(first.first_period)}) บวก = ค่าแรงขึ้นเร็วกว่าของแพง · กดแถวเพื่อดูจังหวัดนั้น`
      : "";
    tableRows($("wage-table"), [
      { label: "จังหวัด" }, { label: "ค่าแรงวันละ", num: true }, { label: "หักของแพงแล้วเหลือ (เงินปี 2566)", num: true }, { label: "ซื้อของได้มากขึ้น/น้อยลง", num: true },
    ], provinces.map((p) => ({ code: p.province_code, cells: [p.province_name, `${num(p.nominal_wage, 0)} ฿`, `${num(p.real_wage, 0)} ฿`, deltaNode(p.real_change_pct, "%", false)] })),
    (row) => { select.value = row.code; drawWage(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  }

  // ราคาต่อหน่วยจากหน่วยของกรมการค้าภายใน เช่น "บาท/15กก." -> ราคาต่อ 1 กก.
  function unitPrice(product) {
    const match = /\/\s*(\d+(?:\.\d+)?)?\s*(.+)$/.exec(product.unit || "");
    const size = match && match[1] ? Number(match[1]) : 1;
    return { price: product.latest_price / size, unit: match ? match[2].trim() : "" };
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
    $("buy-sub").textContent = `ค่าแรงวันละ ${num(last.nominal_wage, 0)} บาท ซื้อได้อย่างใดอย่างหนึ่ง · ราคาจริงตลาดกรุงเทพฯ ${egg ? thDay(egg.price_date) : ""}${code === "10" ? "" : " (จังหวัดอื่นราคาอาจต่างจากนี้)"}`;

    $("wage-takeaway").textContent = `ค่าแรงขั้นต่ำ${data.province_name}ตอนนี้วันละ ${num(last.nominal_wage, 0)} บาท เมื่อหักผลของของแพงแล้ว ซื้อของได้${power >= 0 ? "มากขึ้น" : "น้อยลง"}กว่าเมื่อ ${thMonth(first.period_date)} ${num(Math.abs(power), 1)}% (${power >= 0 ? "ค่าแรงขึ้นเร็วกว่าของแพง" : "ของแพงขึ้นเร็วกว่าค่าแรง"})${eggs ? ` · ค่าแรง 1 วันซื้อไข่ได้ ${num(eggs, 0)} ฟอง` : ""}`;

    line($("chart-wage"), {
      yFormat: (v) => num(v, 0), ariaLabel: "ค่าแรงขั้นต่ำและค่าแรงเมื่อหักของแพงแล้ว",
      series: [
        { name: "ค่าแรงตามประกาศ", short: "ประกาศ", color: cssVar("--series-2"), points: points.map((p) => [parseDate(p.period_date), p.nominal_wage]) },
        { name: "หักของแพงแล้ว (เงินปี 2566)", short: "หักของแพง", color: cssVar("--series-1"), area: true, points: points.map((p) => [parseDate(p.period_date), p.real_wage]) },
      ],
    });
  }

  // ---------- หน้า 5: เบื้องหลังระบบ ----------
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
    const tiles = $("data-tiles");
    tiles.replaceChildren();
    const v = summary.volume;
    tile(tiles, { label: "แถวดัชนีราคา", value: compact(v.cpi_rows), sub: "ตาราง cpi_monthly", icon: "database", tone: "teal" });
    // สนค. ไม่แยกดัชนีกรุงเทพฯ รายจังหวัด กทม. จึงใช้ดัชนี "กรุงเทพฯ และปริมณฑล" จากชุดข้อมูลภาค (+1)
    tile(tiles, { label: "พื้นที่", value: `${v.provinces + 1} จังหวัด`, sub: `${v.provinces} จังหวัด + กทม. (ใช้ดัชนี กทม.และปริมณฑล) · ทั้งประเทศและ 5 ภาค`, icon: "pin", tone: "pink" });
    tile(tiles, { label: "หมวดสินค้า", value: compact(v.commodities), sub: "ระดับ 1–3", icon: "layers", tone: "purple" });
    tile(tiles, { label: "ข้อมูลย้อนหลังถึง", value: thMonth(v.first_period), icon: "calendar", tone: "amber", sub: `โหลดล่าสุด ${new Date(v.last_loaded).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}` });
    bars($("table-counts"), pipelineInfo.tables.map((t) => ({ label: t.name, value: t.rows, color: cssVar("--series-1") })), { format: (x) => compact(x), valueLabel: "แถว" });
    tableRows($("load-table"), [{ label: "แหล่งข้อมูล" }, { label: "แถว", num: true }, { label: "เวลา" }],
      pipelineInfo.loads.map((l) => ({ cells: [SOURCE_NAMES[l.source] || l.source, compact(l.rows_loaded), new Date(l.loaded_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })] })));
    await renderModelQuality();
    bars($("farm-corr"), pipelineInfo.farm_correlations.slice(0, 10).map((c) => ({
      label: `${c.farm_item.replace(/ราคา|ที่เกษตรกรขายได้|รายเดือน|เฉลี่ย/g, "").trim()} · lag ${c.lag_months}`,
      value: c.pearson_correlation,
      color: cssVar("--series-3"),
      extra: [{ label: "จำนวนเดือน", value: String(c.sample_size) }],
    })), { format: (x) => num(x, 2), valueLabel: "r" });
  }

  // ---------- router ----------
  const PAGES = { overview: renderOverview, map: renderMapPage, forecast: renderForecastPage, wage: renderWagePage, data: renderDataPage };
  async function route() {
    const page = (location.hash || "#overview").slice(1);
    // #prices (ลิงก์เดิม/จากหน้าพยากรณ์) = ส่วนราคาของกินในหน้าแรก
    const name = page === "prices" ? "overview" : PAGES[page] ? page : "overview";
    for (const key of Object.keys(PAGES)) $(`page-${key}`).hidden = key !== name;
    document.querySelectorAll(".nav a").forEach((link) => link.classList.toggle("active", link.dataset.page === name));
    if (page !== "prices") window.scrollTo({ top: 0 });
    try {
      await PAGES[name]();
      if (page === "prices") $("price-detail").scrollIntoView({ block: "start" });
    } catch (error) { console.error(error); showError($(`page-${name}`).querySelector(".card") || $(`page-${name}`), error); }
  }
  $("range-chips").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-years]");
    if (!button) return;
    longrunYears = Number(button.dataset.years);
    document.querySelectorAll("#range-chips button").forEach((b) => b.classList.toggle("active", b === button));
    renderLongrun();
  });
  hydrate();
  window.addEventListener("hashchange", route);
  summaryP().then((s) => {
    if (location.hash && location.hash !== "#overview") {
      const v = s.volume;
      $("freshness").textContent = `ข้อมูลถึง ${thMonth(s.latest_period)} · ${compact(v.cpi_rows)} แถว`;
    }
  }).catch(() => {});
  route();
})();
