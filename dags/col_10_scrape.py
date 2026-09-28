"""ขั้นที่ 10: Web scraping ราคาขายปลีกจริงจากหน้าเว็บกรมการค้าภายใน.

API ราคาสินค้า (dataapi.moc.go.th) ล่มบ่อย แต่หน้าเว็บค้นหาราคา
https://data.moc.go.th/OpenData/GISProductPrice ยังใช้ได้ และส่งผลลัพธ์เป็นตาราง HTML
ที่ server สร้างมาแล้ว (ไม่ได้โหลดด้วย JavaScript) จึงอ่านด้วย requests + BeautifulSoup ได้เลย

ขั้นตอน
1. อ่านรายชื่อสินค้าทั้งหมดจาก <select name="product_id"> ของหน้าเว็บ
2. ส่งฟอร์มค้นหา (GET) ทีละสินค้า ทีละช่วง 2 ปี แล้วอ่านตารางราคารายวัน
3. เก็บผลที่อ่านได้เป็นไฟล์ bronze (JSON gzip) ช่วงที่จบไปนานแล้วใช้ไฟล์เดิมไม่ยิงซ้ำ
4. ตรวจคุณภาพ: ต้องเป็นสินค้า "ขายปลีก", หน่วยเป็นบาท, ราคาต่ำสุด <= สูงสุด
5. โหลดเข้า dim_product และ retail_prices_daily (ตารางเดียวกับที่ใช้กับ API)

ถ้าเว็บล่มหรือเปลี่ยนหน้าตา Task จะคืนสถานะผ่าน XCom โดยไม่ทำให้ทั้ง DAG fail
"""

import re
import time
from datetime import date
from typing import Any

import requests
from airflow.providers.postgres.hooks.postgres import PostgresHook
from bs4 import BeautifulSoup

from col_00_settings import (
    MOC_BACKFILL_START_YEAR,
    MOC_TIMEOUT,
    MOC_WEB_MAX_CONSECUTIVE_FAILURES,
    MOC_WEB_PAUSE_SECONDS,
    MOC_WEB_PRODUCT_GROUPS,
    MOC_WEB_STABLE_AFTER_DAYS,
    MOC_WEB_URL,
    MOC_WEB_USER_AGENT,
    MOC_WEB_WINDOW_YEARS,
    POSTGRES_CONN_ID,
    RAW_DIR,
)
from col_01_utils import build_http_session, finite_float, read_json_gz, write_json_gz
from col_02_database import bulk_upsert, log_load

# วันที่บนหน้าเว็บเป็นรูปแบบ เดือน/วัน/ปี ค.ศ. เช่น 9/1/2026
DATE_PATTERN = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
# แถวข้อมูลสินค้า (2 ช่อง: หัวข้อ | ค่า) ที่ต้องการจากตารางสรุป
META_FIELDS = {"ชื่อสินค้า": "name", "หมวดหมู่สินค้า": "category", "กลุ่มสินค้า": "group", "หน่วย": "unit"}
RETAIL_CATEGORY = "ขายปลีก"
MAX_PRICE = 100_000.0  # ราคาต่อหน่วยที่สูงเกินนี้ถือว่าอ่านผิด


def _session() -> requests.Session:
    session = build_http_session(total_retries=2)
    session.headers["User-Agent"] = MOC_WEB_USER_AGENT
    return session


def fetch_catalog(session: requests.Session) -> list[tuple[str, str]]:
    """อ่านรายการสินค้า (รหัส, ชื่อ) จาก dropdown ของฟอร์มค้นหา."""
    response = session.get(MOC_WEB_URL, timeout=MOC_TIMEOUT)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "lxml")
    catalog = []
    for option in soup.select("select[name=product_id] option"):
        product_id = (option.get("value") or "").strip()
        if not product_id:
            continue
        text = option.get_text(" ", strip=True)  # เช่น "P13001 : ผักคะน้า คละ"
        catalog.append((product_id, text.split(":", 1)[1].strip() if ":" in text else text))
    if not catalog:
        raise ValueError("product dropdown not found; page layout may have changed")
    return catalog


def parse_price_page(html: str) -> dict[str, Any]:
    """แยกข้อมูลสินค้าและตารางราคารายวันออกจาก HTML ของหน้าผลการค้นหา."""
    soup = BeautifulSoup(html, "lxml")
    meta: dict[str, str] = {}
    rows: set[tuple[str, str, str]] = set()
    for row in soup.select("table tr"):
        cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"], recursive=False)]
        if len(cells) == 2 and cells[0] in META_FIELDS:
            meta[META_FIELDS[cells[0]]] = cells[1]
        elif len(cells) == 3 and (match := DATE_PATTERN.match(cells[0])):
            month, day, year = (int(part) for part in match.groups())
            # ตารางราคาแสดงซ้ำสองที่บนหน้า จึงเก็บเป็น set เพื่อตัดแถวซ้ำ
            rows.add((date(year, month, day).isoformat(), cells[1], cells[2]))
    return {"meta": meta, "rows": [list(row) for row in sorted(rows)]}


def _windows(today: date) -> list[tuple[date, date]]:
    """ช่วงละ 2 ปี ตั้งแต่ปีเริ่มต้นจนถึงวันนี้."""
    windows = []
    for year in range(MOC_BACKFILL_START_YEAR, today.year + 1, MOC_WEB_WINDOW_YEARS):
        windows.append((date(year, 1, 1), min(date(year + MOC_WEB_WINDOW_YEARS - 1, 12, 31), today)))
    return windows


def cpi_code_for(product_id: str, name: str) -> str:
    """จับคู่สินค้ากับหมวดดัชนีราคาของ สนค. ที่สินค้านั้นอยู่ (ใช้เชื่อมกับค่าพยากรณ์)."""
    if product_id.startswith("R"):
        return "11110"  # ข้าว
    if product_id.startswith("P11"):
        if "ไข่" in name:
            return "11310"  # ไข่
        if "ไก่" in name or "เป็ด" in name:
            return "11221"  # เป็ด ไก่ สด
        return "11211"  # เนื้อสัตว์สด
    if product_id.startswith("P12"):
        if any(word in name for word in ("กุ้ง", "หมึก", "หอย")):
            return "11233"  # สัตว์น้ำ
        if any(word in name for word in ("ปลาทู", "กระพง")):
            return "11232"  # ปลาน้ำทะเลสด
        return "11231"  # ปลาน้ำจืดสด
    if product_id.startswith("P14"):
        return "11421"  # ผลไม้สด
    if product_id.startswith("P16") and "น้ำมัน" in name:
        return "11521"  # น้ำมันและไขมัน
    return "11411"  # ผักสด (รวมกระเทียม หอม พริก ถั่ว)


def _price_or_none(value: str) -> float | None:
    try:
        price = finite_float(value, "price")
    except ValueError:
        return None
    return price if 0 < price < MAX_PRICE else None


def _load_page(session: requests.Session, product_id: str, start: date, end: date, today: date) -> tuple[dict[str, Any], bool]:
    """คืนผลของช่วงเวลาหนึ่ง จาก cache ถ้าช่วงนั้นจบไปนานแล้ว ไม่เช่นนั้นยิง request จริง."""
    cache = RAW_DIR / "moc_web" / product_id / f"{start.year}.json.gz"
    complete = end == date(start.year + MOC_WEB_WINDOW_YEARS - 1, 12, 31)
    if complete and (today - end).days > MOC_WEB_STABLE_AFTER_DAYS and cache.exists():
        cached = read_json_gz(cache)
        if cached.get("window_end") == end.isoformat():
            return cached, True
    time.sleep(MOC_WEB_PAUSE_SECONDS)  # เว้นระยะทุก request ไม่ให้เป็นภาระกับเว็บภาครัฐ
    response = session.get(
        MOC_WEB_URL,
        params={"product_id": product_id, "from_date": start.isoformat(), "to_date": end.isoformat(), "task": "search"},
        timeout=MOC_TIMEOUT,
    )
    response.raise_for_status()
    page = parse_price_page(response.text)
    page["window_end"] = end.isoformat()
    write_json_gz(cache, page)
    return page, False


def _upsert_products(products: list[tuple[str, str, str, str, str]]) -> None:
    """เพิ่ม/อัปเดตสินค้า โดยไม่ทับชื่อสั้น (label) และหมวดของสินค้าอ้างอิงเดิม."""
    if not products:
        return
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    connection = hook.get_conn()
    try:
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO dim_product (product_id, product_name, label, unit, cpi_code, product_group, source)
                VALUES (%s, %s, %s, %s, %s, %s, 'moc_web')
                ON CONFLICT (product_id) DO UPDATE SET
                    product_name = EXCLUDED.product_name,
                    unit = EXCLUDED.unit,
                    product_group = EXCLUDED.product_group,
                    source = EXCLUDED.source;
                """,
                [(pid, name, name, unit, cpi, group) for pid, name, unit, cpi, group in products],
            )
        connection.commit()
    finally:
        connection.close()


def scrape_retail_prices(group: str, **context: Any) -> dict[str, Any]:
    """Scrape ราคาขายปลีกรายวันของสินค้าทุกตัวในกลุ่มรหัสที่กำหนด."""
    source = f"moc_web_{group}"
    prefixes = MOC_WEB_PRODUCT_GROUPS[group]
    session = _session()
    today = date.today()
    try:
        catalog = [(pid, name) for pid, name in fetch_catalog(session) if pid.startswith(prefixes)]
    except (requests.RequestException, ValueError) as exc:
        print(f"WARN cannot read product list: {exc}")
        log_load(context, source, 0, "status=unavailable")
        return {"source": source, "status": "unavailable", "record_count": 0}

    price_rows: list[tuple[Any, ...]] = []
    products: list[tuple[str, str, str, str, str]] = []
    skipped: dict[str, str] = {}
    stats = {"requests": 0, "cache_hits": 0, "failed_requests": 0}
    consecutive_failures = 0
    for product_id, option_name in catalog:
        # Circuit breaker: ล้มติดกันหลายครั้งแปลว่าเว็บล่ม หยุดรอบนี้แล้วให้รอบหน้าดึงต่อ
        if consecutive_failures >= MOC_WEB_MAX_CONSECUTIVE_FAILURES:
            print("Website looks down; stop scraping for this run")
            break
        meta: dict[str, str] = {}
        product_rows: list[tuple[Any, ...]] = []
        for start, end in _windows(today):
            try:
                page, from_cache = _load_page(session, product_id, start, end, today)
            except requests.RequestException as exc:
                stats["failed_requests"] += 1
                consecutive_failures += 1
                print(f"WARN {product_id} {start.year}: {exc}")
                continue
            consecutive_failures = 0
            stats["cache_hits" if from_cache else "requests"] += 1
            meta = page["meta"] or meta
            for day, low_text, high_text in page["rows"]:
                low, high = _price_or_none(low_text), _price_or_none(high_text)
                if low is not None and high is not None and low <= high:
                    product_rows.append((product_id, date.fromisoformat(day), low, high))

        # ตรวจคุณภาพระดับสินค้า: รับเฉพาะราคาขายปลีกที่หน่วยเป็นบาท
        unit = re.sub(r"\s+", "", meta.get("unit", ""))
        if not product_rows:
            skipped[product_id] = "no prices"
        elif meta.get("category") != RETAIL_CATEGORY:
            skipped[product_id] = f"category={meta.get('category')}"
        elif not unit.startswith("บาท"):
            skipped[product_id] = f"unit={unit}"
        else:
            name = meta.get("name") or option_name
            products.append((product_id, name, unit, cpi_code_for(product_id, name), meta.get("group", "")))
            price_rows.extend(product_rows)

    _upsert_products(products)
    loaded = bulk_upsert(
        "retail_prices_daily",
        ["product_id", "price_date", "price_min", "price_max"],
        ["product_id", "price_date"],
        price_rows,
    )
    if not products:
        status = "unavailable"
    elif stats["failed_requests"]:
        status = "partial"
    else:
        status = "ok"
    log_load(context, source, loaded, f"status={status} products={len(products)} requests={stats['requests']}")
    result = {
        "source": source,
        "status": status,
        "record_count": loaded,
        "products_with_data": len(products),
        "products_skipped": len(skipped),
        **stats,
    }
    print(f"Skipped products: {skipped}")
    print(f"Extracted {result}")
    return result
