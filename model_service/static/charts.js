/* ไลบรารีกราฟขนาดเล็ก (SVG/HTML ล้วน ไม่พึ่ง library ภายนอก)
 * - line: กราฟเส้นหลาย series + crosshair/tooltip + legend + end label
 * - bars: แท่งแนวนอนแบบ diverging (แพงขึ้น = แดง, ถูกลง = ฟ้า)
 * - map: แผนที่จังหวัดระบายสีตามค่า (choropleth)
 * - sparkline: เส้นเล็กในการ์ดตัวเลข
 * ข้อความจากข้อมูลทุกจุดใส่ด้วย textContent เพื่อกัน HTML injection
 */
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const svgEl = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const monthLabel = (date) => `${TH_MONTHS[date.getMonth()]} ${date.getFullYear() + 543}`;

  // พื้นไล่สีจางใต้เส้น (สีเดียวกับเส้น ทึบด้านบน จางลงจนโปร่งที่ฐาน)
  let gradientCounter = 0;
  function areaGradient(svg, color, opacity = 0.2) {
    const id = `area-${++gradientCounter}`;
    const defs = svgEl("defs", {}, svg);
    const gradient = svgEl("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", "stop-color": color, "stop-opacity": opacity }, gradient);
    svgEl("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }, gradient);
    return `url(#${id})`;
  }

  // ---------- tooltip ----------
  const tooltip = () => document.getElementById("tooltip");
  function showTooltip(event, title, rows) {
    const box = tooltip();
    box.replaceChildren();
    box.appendChild(el("div", "t-title", title));
    for (const row of rows) {
      const line = el("div", "t-row");
      const key = el("span", "t-key");
      if (row.color) {
        const swatch = el("i");
        swatch.style.background = row.color;
        key.appendChild(swatch);
      }
      key.appendChild(document.createTextNode(row.label));
      line.appendChild(key);
      line.appendChild(el("b", "", row.value));
      box.appendChild(line);
    }
    box.hidden = false;
    const pad = 14;
    const { innerWidth, innerHeight } = window;
    const rect = box.getBoundingClientRect();
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + rect.width > innerWidth - 8) left = event.clientX - rect.width - pad;
    if (top + rect.height > innerHeight - 8) top = event.clientY - rect.height - pad;
    box.style.left = `${Math.max(8, left)}px`;
    box.style.top = `${Math.max(8, top)}px`;
  }
  const hideTooltip = () => { tooltip().hidden = true; };

  // ---------- scale helpers ----------
  function niceStep(range, count) {
    const raw = range / Math.max(count, 1);
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const fraction = raw / power;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * power;
  }
  function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const step = niceStep(max - min, count);
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }
  function timeTicks(minTime, maxTime, width) {
    const minDate = new Date(minTime);
    const maxDate = new Date(maxTime);
    const years = (maxTime - minTime) / (365.25 * 864e5);
    const maxTicks = Math.max(2, Math.floor(width / 80));
    if (years < 3) {
      // ช่วงสั้น: ติ๊กทุก 3 / 6 เดือน
      const stepMonths = years < 1.5 ? 3 : 6;
      const ticks = [];
      const cursor = new Date(minDate.getFullYear(), Math.ceil(minDate.getMonth() / stepMonths) * stepMonths, 1);
      while (cursor <= maxDate) {
        ticks.push({ time: cursor.getTime(), label: monthLabel(cursor) });
        cursor.setMonth(cursor.getMonth() + stepMonths);
      }
      return ticks;
    }
    const steps = [1, 2, 5, 10, 20];
    const step = steps.find((s) => years / s <= maxTicks) || 20;
    const ticks = [];
    for (let year = Math.ceil(minDate.getFullYear() / step) * step; year <= maxDate.getFullYear(); year += step) {
      const time = new Date(year, 0, 1).getTime();
      if (time >= minTime && time <= maxTime) ticks.push({ time, label: String(year + 543) });
    }
    return ticks;
  }

  // วาดใหม่อัตโนมัติเมื่อความกว้างของกล่องเปลี่ยน
  function responsive(container, draw) {
    if (container._observer) container._observer.disconnect();
    // วาดทันทีหนึ่งครั้ง ไม่ต้องรอ ResizeObserver (ซึ่งทำงานเฉพาะตอนเบราว์เซอร์วาดเฟรม)
    let lastWidth = container.clientWidth || 720;
    draw(lastWidth);
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (width && Math.abs(width - lastWidth) > 2) { lastWidth = width; draw(width); }
    });
    observer.observe(container);
    container._observer = observer;
  }

  // ---------- legend ----------
  function legend(container, items) {
    const box = el("div", "legend");
    for (const item of items) {
      const entry = el("span");
      const key = el("i", ["dot", "dash", "band"].includes(item.kind) ? item.kind : "");
      if (item.kind === "dash") key.style.color = item.color; else key.style.background = item.color;
      entry.appendChild(key);
      entry.appendChild(document.createTextNode(item.label));
      box.appendChild(entry);
    }
    container.appendChild(box);
  }

  // ---------- line chart ----------
  function line(container, options) {
    const series = options.series.filter((s) => s.points.length);
    container.replaceChildren();
    if (!series.length) { container.appendChild(el("div", "empty-state", options.empty || "ไม่มีข้อมูล")); return; }
    const format = options.yFormat || ((v) => v.toFixed(1));
    const height = options.height || 300;
    const showLegend = series.length > 1 || options.forceLegend;
    // band = แถบช่วงค่าต่ำสุด-สูงสุด (เช่น ราคาต่ำสุด-สูงสุดของเดือน) วาดใต้เส้น
    const band = options.band ? options.band.points.filter((p) => Number.isFinite(p[1]) && Number.isFinite(p[2])) : [];
    if (showLegend || band.length) {
      legend(container, [
        ...series.map((s) => ({ label: s.name, color: s.color, kind: s.dotsOnly ? "dot" : s.dashed ? "dash" : "line" })),
        ...(band.length ? [{ label: options.band.name, color: options.band.color, kind: "band" }] : []),
      ]);
    }
    const holder = el("div");
    container.appendChild(holder);

    const draw = (width) => {
      holder.replaceChildren();
      const useEndLabels = options.endLabels !== false && series.length <= 4 && width > 520;
      const margin = { top: 12, right: useEndLabels ? 116 : 18, bottom: 28, left: 46 };
      const innerW = Math.max(40, width - margin.left - margin.right);
      const innerH = height - margin.top - margin.bottom;
      const allPoints = series.flatMap((s) => s.points);
      const times = [...allPoints, ...band].map((p) => p[0].getTime());
      const values = [...allPoints.map((p) => p[1]), ...band.flatMap((p) => [p[1], p[2]])].filter((v) => v !== null && Number.isFinite(v));
      const minT = Math.min(...times), maxT = Math.max(...times);
      let minV = Math.min(...values), maxV = Math.max(...values);
      if (options.includeZero) { minV = Math.min(0, minV); maxV = Math.max(0, maxV); }
      const pad = (maxV - minV) * 0.06 || 1;
      const yTicks = niceTicks(minV - pad, maxV + pad, Math.max(3, Math.floor(innerH / 60)));
      const y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
      const sx = (t) => margin.left + ((t - minT) / (maxT - minT || 1)) * innerW;
      const sy = (v) => margin.top + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;

      const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img", "aria-label": options.ariaLabel || "กราฟเส้น" }, holder);
      // gridline แนวนอนแบบเส้นบาง และตัวเลขแกน y
      for (const tick of yTicks) {
        svgEl("line", { x1: margin.left, x2: margin.left + innerW, y1: sy(tick), y2: sy(tick), stroke: cssVar(tick === 0 && y0 < 0 ? "--axis" : "--grid"), "stroke-width": 1 }, svg);
        const label = svgEl("text", { x: margin.left - 8, y: sy(tick) + 4, "text-anchor": "end", class: "axis-text" }, svg);
        label.textContent = format(tick, true);
      }
      svgEl("line", { x1: margin.left, x2: margin.left + innerW, y1: margin.top + innerH, y2: margin.top + innerH, stroke: cssVar("--axis"), "stroke-width": 1 }, svg);
      for (const tick of timeTicks(minT, maxT, innerW)) {
        const label = svgEl("text", { x: sx(tick.time), y: height - 8, "text-anchor": "middle", class: "axis-text" }, svg);
        label.textContent = tick.label;
      }
      if (band.length) {
        const upper = band.map((p, i) => `${i ? "L" : "M"}${sx(p[0].getTime()).toFixed(1)},${sy(p[2]).toFixed(1)}`).join("");
        const lower = [...band].reverse().map((p) => `L${sx(p[0].getTime()).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
        svgEl("path", { d: `${upper}${lower}Z`, fill: options.band.color, "fill-opacity": 0.16, stroke: "none" }, svg);
      }
      // เส้นข้อมูล
      const endLabels = [];
      for (const s of series) {
        const pts = s.points.filter((p) => p[1] !== null && Number.isFinite(p[1]));
        if (s.dotsOnly) {
          for (const p of pts) {
            svgEl("circle", { cx: sx(p[0].getTime()), cy: sy(p[1]), r: 4, fill: s.color, stroke: cssVar("--surface"), "stroke-width": 2 }, svg);
          }
          continue;
        }
        const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0].getTime()).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
        if (s.area && pts.length > 1) {
          const baseY = (margin.top + innerH).toFixed(1);
          const area = `${d}L${sx(pts[pts.length - 1][0].getTime()).toFixed(1)},${baseY}L${sx(pts[0][0].getTime()).toFixed(1)},${baseY}Z`;
          svgEl("path", { d: area, fill: areaGradient(svg, s.color, s.areaOpacity || 0.18), stroke: "none" }, svg);
        }
        svgEl("path", {
          d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
          ...(s.dashed ? { "stroke-dasharray": "5 4" } : {}),
        }, svg);
        const last = pts[pts.length - 1];
        if (last && s.endDot !== false) {
          svgEl("circle", { cx: sx(last[0].getTime()), cy: sy(last[1]), r: 4, fill: s.color, stroke: cssVar("--surface"), "stroke-width": 2 }, svg);
        }
        if (last && useEndLabels && s.endLabel !== false) endLabels.push({ y: sy(last[1]), x: sx(last[0].getTime()), text: `${s.short || s.name} ${format(last[1])}` });
      }
      // end label: ถ้าชนกันจะไม่วาดตัวที่ชน (ยังมี legend และ tooltip ให้ดู)
      endLabels.sort((a, b) => a.y - b.y);
      let lastY = -Infinity;
      for (const item of endLabels) {
        if (item.y - lastY < 15) continue;
        const label = svgEl("text", { x: item.x + 9, y: item.y + 4, class: "end-label" }, svg);
        label.textContent = item.text;
        lastY = item.y;
      }

      // crosshair + tooltip: หาเดือนที่ใกล้ตัวชี้ที่สุด แล้วแสดงค่าทุก series ในเดือนนั้น
      const lookup = series.map((s) => new Map(s.points.map((p) => [p[0].getTime(), p[1]])));
      const bandLookup = new Map(band.map((p) => [p[0].getTime(), p]));
      const uniqueTimes = [...new Set(times)].sort((a, b) => a - b);
      const cross = svgEl("line", { y1: margin.top, y2: margin.top + innerH, stroke: cssVar("--axis"), "stroke-width": 1, visibility: "hidden" }, svg);
      const dots = series.map((s) => svgEl("circle", { r: 4, fill: s.color, stroke: cssVar("--surface"), "stroke-width": 2, visibility: "hidden" }, svg));
      const overlay = svgEl("rect", { x: margin.left, y: margin.top, width: innerW, height: innerH, fill: "transparent" }, svg);
      overlay.addEventListener("pointermove", (event) => {
        const box = svg.getBoundingClientRect();
        const px = ((event.clientX - box.left) / box.width) * width;
        const target = minT + ((px - margin.left) / innerW) * (maxT - minT);
        let lo = 0, hi = uniqueTimes.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (uniqueTimes[mid] < target) lo = mid; else hi = mid; }
        const time = Math.abs(uniqueTimes[lo] - target) < Math.abs(uniqueTimes[hi] - target) ? uniqueTimes[lo] : uniqueTimes[hi];
        cross.setAttribute("x1", sx(time)); cross.setAttribute("x2", sx(time)); cross.setAttribute("visibility", "visible");
        const rows = [];
        series.forEach((s, i) => {
          const value = lookup[i].get(time);
          if (value === undefined || value === null) { dots[i].setAttribute("visibility", "hidden"); return; }
          dots[i].setAttribute("cx", sx(time)); dots[i].setAttribute("cy", sy(value)); dots[i].setAttribute("visibility", "visible");
          rows.push({ color: s.color, label: s.name, value: format(value) });
        });
        const range = bandLookup.get(time);
        if (range) rows.push({ color: options.band.color, label: options.band.name, value: `${format(range[1])} – ${format(range[2])}` });
        showTooltip(event, monthLabel(new Date(time)), rows);
      });
      overlay.addEventListener("pointerleave", () => {
        cross.setAttribute("visibility", "hidden");
        dots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
        hideTooltip();
      });
    };
    responsive(holder, draw);
  }

  // ---------- diverging bars ----------
  function bars(container, items, options = {}) {
    container.replaceChildren();
    if (!items.length) { container.appendChild(el("div", "empty-state", options.empty || "ไม่มีข้อมูล")); return; }
    const format = options.format || ((v) => v.toFixed(2));
    const values = items.map((item) => item.value);
    const minV = Math.min(0, ...values), maxV = Math.max(0, ...values);
    const span = maxV - minV || 1;
    const offset = minV < 0 ? 14 : 2, usable = minV < 0 ? 72 : 82; // เผื่อที่ให้ตัวเลขปลายแท่ง
    const x = (v) => offset + ((v - minV) / span) * usable;
    const list = el("div", "bars");
    for (const item of items) {
      const row = el("div", "bar-row");
      row.tabIndex = 0;
      const label = el("div", "bar-label", item.label);
      label.title = item.label;
      const track = el("div", "bar-track");
      const zero = el("div", "bar-zero");
      zero.style.left = `${x(0)}%`;
      const positive = item.value >= 0;
      const bar = el("div", `bar ${positive ? "pos" : "neg"}`);
      bar.style.left = `${Math.min(x(0), x(item.value))}%`;
      bar.style.width = `${Math.max(0.4, Math.abs(x(item.value) - x(0)))}%`;
      bar.style.background = item.color || cssVar(positive ? "--div-pos-2" : "--div-neg-2");
      const value = el("div", "bar-value", format(item.value));
      if (positive) value.style.left = `calc(${x(item.value)}% + 6px)`;
      else value.style.right = `calc(${100 - x(item.value)}% + 6px)`;
      track.append(zero, bar, value);
      row.append(label, track);
      const tip = (event) => showTooltip(event, item.label, [{ label: options.valueLabel || "ค่า", value: format(item.value), color: bar.style.background }, ...(item.extra || [])]);
      row.addEventListener("pointermove", tip);
      row.addEventListener("pointerleave", hideTooltip);
      if (options.onClick) row.addEventListener("click", () => options.onClick(item));
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  // ---------- diverging color scale (7 ขั้น, กลาง = เทา) ----------
  function divergingColor(value, maxAbs) {
    if (value === null || value === undefined || !Number.isFinite(value)) return cssVar("--grid");
    const t = maxAbs / 3;
    if (value < -2 * t) return cssVar("--div-neg-3");
    if (value < -t) return cssVar("--div-neg-2");
    if (value < -0.2 * t) return cssVar("--div-neg-1");
    if (value <= 0.2 * t) return cssVar("--div-mid");
    if (value <= t) return cssVar("--div-pos-1");
    if (value <= 2 * t) return cssVar("--div-pos-2");
    return cssVar("--div-pos-3");
  }
  function divergingLegend(container, maxAbs, format) {
    container.replaceChildren();
    const ramp = el("div", "ramp");
    for (const name of ["--div-neg-3", "--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2", "--div-pos-3"]) {
      const cell = el("span");
      cell.style.background = cssVar(name);
      ramp.appendChild(cell);
    }
    const ticks = el("div", "ticks");
    ticks.append(el("span", "", `ถูกลง ${format(-maxAbs)}`), el("span", "", "0"), el("span", "", `แพงขึ้น ${format(maxAbs)}`));
    container.append(ramp, ticks);
  }

  // ---------- choropleth map ----------
  function map(container, geo, options) {
    container.replaceChildren();
    const features = geo.features;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const feature of features) for (const polygon of feature.geometry.coordinates) for (const ring of polygon) for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const width = 400;
    const scale = width / ((maxLon - minLon) * kx);
    const height = (maxLat - minLat) * scale;
    const svg = svgEl("svg", { viewBox: `-4 -4 ${width + 8} ${height + 8}`, role: "img", "aria-label": options.ariaLabel || "แผนที่ประเทศไทย" }, container);
    const project = ([lon, lat]) => `${((lon - minLon) * kx * scale).toFixed(1)},${((maxLat - lat) * scale).toFixed(1)}`;
    const paths = new Map();
    for (const feature of features) {
      const { code, name } = feature.properties;
      const d = feature.geometry.coordinates.map((polygon) => polygon.map((ring) => `M${ring.map(project).join("L")}Z`).join("")).join("");
      const record = options.values.get(code);
      const path = svgEl("path", { d, fill: divergingColor(record ? record.value : null, options.maxAbs), tabindex: 0 }, svg);
      path.addEventListener("pointermove", (event) => {
        showTooltip(event, name, record
          ? [{ label: options.valueLabel || "ค่า", value: options.format(record.value), color: path.getAttribute("fill") }, ...(record.extra || [])]
          : [{ label: "ไม่มีข้อมูล", value: "–" }]);
      });
      path.addEventListener("pointerleave", hideTooltip);
      path.addEventListener("click", () => options.onSelect && options.onSelect(code));
      path.addEventListener("keydown", (event) => { if (event.key === "Enter") options.onSelect && options.onSelect(code); });
      paths.set(code, path);
    }
    return {
      select(code) {
        for (const [key, path] of paths) path.classList.toggle("selected", key === code);
        const chosen = paths.get(code);
        if (chosen) svg.appendChild(chosen); // ยกขึ้นมาบนสุด ให้ขอบไม่ถูกจังหวัดข้างเคียงทับ
      },
    };
  }

  // ---------- sparkline ----------
  function sparkline(container, values, options = {}) {
    container.replaceChildren();
    const points = values.filter((v) => v !== null && Number.isFinite(v));
    if (points.length < 2) return;
    const width = 260, height = options.height || 44;
    const min = Math.min(...points, options.includeZero ? 0 : Infinity), max = Math.max(...points, options.includeZero ? 0 : -Infinity);
    const sx = (i) => 4 + (i / (points.length - 1)) * (width - 8);
    const sy = (v) => 4 + (1 - (v - min) / (max - min || 1)) * (height - 8);
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", height, width: "100%" }, container);
    // อ่านสีจากกล่องที่วาด (ไม่ใช่ :root) เพื่อให้ใช้ได้ทั้งบนการ์ดสว่างและการ์ดมืด
    const local = (name) => getComputedStyle(container).getPropertyValue(name).trim();
    const color = options.color || local("--tone") || local("--series-1");
    const d = points.map((v, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join("");
    if (options.area !== false) {
      svgEl("path", { d: `${d}L${sx(points.length - 1).toFixed(1)},${height}L${sx(0).toFixed(1)},${height}Z`, fill: areaGradient(svg, color, 0.22), stroke: "none" }, svg);
    }
    if (options.includeZero && min < 0) svgEl("line", { x1: 0, x2: width, y1: sy(0), y2: sy(0), stroke: local("--axis"), "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);
    svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }, svg);
  }

  window.Charts = { line, bars, map, sparkline, legend, divergingColor, divergingLegend, showTooltip, hideTooltip, cssVar, monthLabel, niceStep };
})();
