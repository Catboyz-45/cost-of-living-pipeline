"""ขั้นที่ 03: ดึงข้อมูลจาก API/ไฟล์ของหน่วยงานรัฐ แล้วโหลดเข้าตาราง silver.

แหล่งข้อมูลหลัก (CPI ของ สนค.) ต้องสำเร็จ ถ้าล้มเหลว Task จะ fail และ retry
แหล่งเสริม (ราคาขายปลีก, ราคาหน้าฟาร์ม, ค่าแรง) ล้มเหลวได้โดยไม่หยุดทั้ง pipeline
เพราะ Task จะคืนสถานะผ่าน XCom ให้ขั้น Validate ตัดสินใจต่อ
"""

import csv
import io
import time
from datetime import date, datetime, timedelta
from typing import Any

import requests
from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import (
    ANCHOR_PRODUCTS,
    CACHE_STABLE_AFTER_MONTHS,
    CPI_DATASETS,
    CPI_YEAR_BASE,
    DATA_GO_TH_PACKAGE_URL,
    FARM_PRICE_PACKAGE,
    INCREMENTAL_MONTHS,
    MINIMUM_WAGE_EXTRA_CSV,
    MINIMUM_WAGE_PACKAGES,
    MOC_BACKFILL_START_YEAR,
    MOC_INCREMENTAL_DAYS,
    MOC_MAX_CONSECUTIVE_FAILURES,
    MOC_PRICE_URL,
    MOC_TIMEOUT,
    POSTGRES_CONN_ID,
    RAW_DIR,
    REQUEST_PAUSE_SECONDS,
    TPSO_API_BASE,
)
from col_01_utils import (
    THAI_MONTHS,
    be_to_ce,
    build_http_session,
    finite_float,
    iter_months,
    parse_thai_date,
    read_json_gz,
    shift_month,
    write_json_gz,
)
from col_02_database import bulk_upsert, log_load

CPI_COLUMNS = [
    "area_type", "area_code", "commodity_code", "period_date", "index_value",
    "change_mom", "change_yoy", "change_avg", "year_base",
]
CPI_KEYS = ["area_type", "area_code", "commodity_code", "period_date"]

# จังหวัดในกลุ่ม "กรุงเทพฯ และปริมณฑล" ตามการจัดกลุ่มของดัชนี สนค.
BANGKOK_METRO = {"10", "11", "12", "13", "73", "74"}

# ชื่อเต็มของรหัสภาคในดัชนี สนค.
REGION_NAMES = {
    "TG": "ทั้งประเทศ",
    "10": "กรุงเทพฯ และปริมณฑล",
    "CC": "ภาคกลาง",
    "NN": "ภาคเหนือ",
    "EE": "ภาคตะวันออกเฉียงเหนือ",
    "SS": "ภาคใต้",
}


def province_region(code: str) -> str:
    """จัดจังหวัดเข้าภาคของดัชนี สนค. จากช่วงรหัสจังหวัดมาตรฐาน."""
    if code in BANGKOK_METRO:
        return "10"
    number = int(code)
    if 30 <= number <= 49:
        return "EE"  # ตะวันออกเฉียงเหนือ
    if 50 <= number <= 67:
        return "NN"  # เหนือ
    if 80 <= number <= 96:
        return "SS"  # ใต้
    return "CC"  # กลาง ตะวันออก และตะวันตก


def _optional_float(value: Any) -> float | None:
    """คืน None เมื่อต้นทางไม่มีค่า แทนการทำให้ทั้งแถวใช้ไม่ได้."""
    if value is None or value == "":
        return None
    try:
        return finite_float(value, "optional")
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# แหล่งข้อมูลที่ 1: ดัชนีราคาผู้บริโภค (สนค.)
# ---------------------------------------------------------------------------
def _tpso_master_data(session: requests.Session, dataset: str) -> dict[str, Any]:
    """อ่านรายชื่อพื้นที่ หมวดสินค้า และเดือนล่าสุดที่มีข้อมูล."""
    path = CPI_DATASETS[dataset]["path"]
    response = session.get(f"{TPSO_API_BASE}/{path}/MasterData", timeout=(10, 60))
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not payload.get("types"):
        raise ValueError(f"Unexpected MasterData response for {dataset}")

    # เลือกช่วงข้อมูลของปีฐานที่โปรเจกต์ใช้ เพื่อไม่ปนดัชนีคนละปีฐาน
    periods = [
        period for period in payload.get("dataAvailablePeriods", [])
        if period.get("periodType") == "month" and period.get("yearBase") == CPI_YEAR_BASE
    ]
    if not periods:
        raise ValueError(f"Year base {CPI_YEAR_BASE} is not available for {dataset}")
    return {
        "areas": {str(item["code"]): item["name"].strip() for item in payload["types"]},
        "commodities": {
            str(item["code"]): (item["name"].strip(), int(item["level"]))
            for item in payload["commodities"]
        },
        "end": (int(periods[0]["endYear"]), int(periods[0]["endPeriod"])),
    }


def _fetch_cpi_year(
    session: requests.Session,
    dataset: str,
    area_code: str,
    year_be: int,
    latest: tuple[int, int],
    stats: dict[str, int],
) -> list[dict[str, Any]]:
    """ดึงหนึ่งพื้นที่ทั้งปี (12 เดือน) ในครั้งเดียว และใช้ไฟล์ Bronze ถ้าเป็นปีที่คงที่แล้ว.

    ถ้าไม่ส่ง "month" ไป API ของ สนค. จะคืนข้อมูลครบทุกเดือนของปีนั้น ทำให้จำนวน
    request ลดลง 12 เท่า (เซิร์ฟเวอร์ตอบทีละ request จึงยิงขนานมากไม่ได้ช่วย)
    """
    cache_path = RAW_DIR / "tpso" / dataset / str(year_be) / f"{area_code}.json.gz"
    stable_before = shift_month(*latest, -CACHE_STABLE_AFTER_MONTHS)
    if cache_path.exists() and (year_be, 12) <= stable_before:
        stats["cache_hits"] += 1
        return read_json_gz(cache_path)

    response = session.post(
        f"{TPSO_API_BASE}/{CPI_DATASETS[dataset]['path']}",
        json={
            "yearBase": CPI_YEAR_BASE,
            "year": year_be,
            "type": area_code,
            "commodities": [],  # ว่าง = ขอทุกหมวดสินค้า
        },
        timeout=(10, 120),
    )
    stats["api_calls"] += 1
    time.sleep(REQUEST_PAUSE_SECONDS)
    if response.status_code != 200:
        stats["failed_requests"] += 1
        print(f"WARN {dataset} {area_code} {year_be}: HTTP {response.status_code}")
        return []
    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError(f"Unexpected CPI response for {dataset} {area_code}")
    # เก็บ response ดิบไว้ก่อนแปลง เพื่อรันซ้ำหรือตรวจย้อนหลังได้โดยไม่เรียก API
    write_json_gz(cache_path, payload)
    return payload


def _cpi_rows(dataset: str, payload: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    """แปลง JSON ของ สนค. เป็น tuple ตามคอลัมน์ตาราง cpi_monthly."""
    area_type = CPI_DATASETS[dataset]["area_type"]
    rows = []
    for item in payload:
        try:
            index_value = finite_float(item["index"], "index")
            period = date(be_to_ce(int(item["year"])), int(item["month"]), 1)
        except (KeyError, TypeError, ValueError):
            continue
        # ดัชนีต้องเป็นบวก ค่า 0 หรือติดลบหมายถึงไม่มีการเก็บราคาเดือนนั้น
        if index_value <= 0:
            continue
        rows.append(
            (
                area_type,
                str(item["type"]),
                str(item["commodityCode"]),
                period,
                index_value,
                _optional_float(item.get("change")),
                _optional_float(item.get("changeYear")),
                _optional_float(item.get("changeAVG")),
                int(item.get("yearBase") or CPI_YEAR_BASE),
            )
        )
    return rows


def _upsert_dimensions(dataset: str, master: dict[str, Any]) -> None:
    """บันทึกชื่อพื้นที่และหมวดสินค้าจาก MasterData."""
    area_type = CPI_DATASETS[dataset]["area_type"]
    area_rows = [
        (
            area_type,
            code,
            # ชื่อภาคจาก API เป็นตัวย่อ จึงใช้ชื่อเต็มแทนเพื่อให้ dashboard อ่านง่าย
            REGION_NAMES.get(code, name) if area_type == "region" else name,
            code if area_type == "region" else province_region(code),
        )
        for code, name in master["areas"].items()
    ]
    bulk_upsert(
        "dim_area",
        ["area_type", "area_code", "area_name", "region_code"],
        ["area_type", "area_code"],
        area_rows,
    )
    commodity_rows = [
        (code, name, level) for code, (name, level) in master["commodities"].items()
    ]
    bulk_upsert(
        "dim_commodity",
        ["commodity_code", "commodity_name", "level"],
        ["commodity_code"],
        commodity_rows,
    )


def extract_cpi(
    dataset: str,
    start_year_be: int | None = None,
    end_year_be: int | None = None,
    incremental: bool = False,
    **context: Any,
) -> dict[str, Any]:
    """ดึงดัชนีราคาผู้บริโภคหนึ่งชุด (ประเทศ/ภาค หรือ จังหวัด) ตามช่วงเดือน."""
    if dataset not in CPI_DATASETS:
        raise ValueError("CPI dataset is not allowlisted")

    session = build_http_session()
    master = _tpso_master_data(session, dataset)
    _upsert_dimensions(dataset, master)
    latest = master["end"]

    # incremental = ดึงเฉพาะ N เดือนล่าสุด, backfill = ตามช่วงปีที่ Task ได้รับ
    if incremental:
        months = list(iter_months(shift_month(*latest, -(INCREMENTAL_MONTHS - 1)), latest))
    else:
        first = (start_year_be or CPI_DATASETS[dataset]["start_year_be"], 1)
        last = min((end_year_be, 12), latest) if end_year_be else latest
        months = list(iter_months(first, last))
    wanted = {date(be_to_ce(year), month, 1) for year, month in months}
    years = sorted({year for year, _ in months})

    stats = {"api_calls": 0, "cache_hits": 0, "failed_requests": 0}
    buffer: list[tuple[Any, ...]] = []
    loaded = 0
    periods: set[date] = set()
    for year_be in years:
        for area_code in master["areas"]:
            payload = _fetch_cpi_year(session, dataset, area_code, year_be, latest, stats)
            # เก็บเฉพาะเดือนที่อยู่ในช่วงของ Task นี้ (incremental ไม่ต้องการทั้งปี)
            rows = [row for row in _cpi_rows(dataset, payload) if row[3] in wanted]
            buffer.extend(rows)
            periods.update(row[3] for row in rows)
            # เขียนลงฐานข้อมูลเป็นระยะ ไม่เก็บข้อมูลหลายแสนแถวค้างไว้ในหน่วยความจำ
            if len(buffer) >= 150_000:
                loaded += bulk_upsert("cpi_monthly", CPI_COLUMNS, CPI_KEYS, buffer)
                buffer = []
        print(f"{dataset} {year_be}: loaded so far {loaded + len(buffer):,} rows {stats}")
    loaded += bulk_upsert("cpi_monthly", CPI_COLUMNS, CPI_KEYS, buffer)

    # ถ้า request ล้มเหลวเกิน 2% ถือว่าข้อมูลไม่ครบ ให้ Task fail แล้ว Airflow retry
    total_requests = stats["api_calls"] + stats["cache_hits"]
    if total_requests and stats["failed_requests"] / total_requests > 0.02:
        raise RuntimeError(f"Too many failed CPI requests: {stats}")

    log_load(context, f"tpso_{dataset}", loaded, f"months={len(months)} {stats}")
    # XCom เก็บเฉพาะสรุปขนาดเล็ก ไม่ส่งข้อมูลหลายแสนแถวผ่าน XCom
    result = {
        "source": f"tpso_{dataset}",
        "status": "ok",
        "record_count": loaded,
        "area_count": len(master["areas"]),
        "month_count": len(months),
        "first_period": min(periods).isoformat() if periods else None,
        "latest_period": max(periods).isoformat() if periods else None,
        **stats,
    }
    print(f"Extracted {result}")
    return result


# ---------------------------------------------------------------------------
# แหล่งข้อมูลที่ 2: ราคาขายปลีกรายวันเป็นบาท (กรมการค้าภายใน)
# ---------------------------------------------------------------------------
def _ensure_anchor_products() -> None:
    """ใส่รายการสินค้าอ้างอิงไว้ก่อน แม้ API ราคาจะล่มในรอบนี้."""
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    for product in ANCHOR_PRODUCTS:
        hook.run(
            """
            INSERT INTO dim_product (product_id, product_name, label, unit, cpi_code)
            VALUES (%s, %s, %s, NULL, %s)
            ON CONFLICT (product_id) DO UPDATE SET
                label = EXCLUDED.label, cpi_code = EXCLUDED.cpi_code;
            """,
            parameters=(product["product_id"], product["label"], product["label"], product["cpi_code"]),
        )


def _retail_windows(first_loaded: date | None, incremental: bool, today: date) -> list[tuple[date, date]]:
    """ช่วงวันที่ต้องดึงของสินค้าหนึ่งตัว.

    รอบรายเดือนดึง 120 วันล่าสุด แต่ถ้าสินค้าตัวนั้นยังไม่มีประวัติย้อนหลังครบ
    (เพราะ API ล่มตอน backfill) จะดึงปีที่ขาดเพิ่มด้วย ข้อมูลจึงค่อย ๆ ครบเอง
    """
    windows = [(today - timedelta(days=MOC_INCREMENTAL_DAYS), today)] if incremental else []
    history_end = first_loaded or today
    # แบ่งทีละปี เพราะ API ตอบช้ามากเมื่อขอช่วงยาว; เรียงจากปีใหม่ไปเก่าเพื่อให้ได้ราคาล่าสุดก่อน
    for year in range(history_end.year, MOC_BACKFILL_START_YEAR - 1, -1):
        window_start = date(year, 1, 1)
        window_end = min(date(year, 12, 31), history_end, today)
        if window_start < window_end:
            windows.append((window_start, window_end))
    return windows


def extract_retail_prices(incremental: bool = False, **context: Any) -> dict[str, Any]:
    """ดึงราคาขายปลีกของสินค้าอ้างอิง ถ้า API ล่มจะหยุดเร็วและไม่ทำให้ DAG fail."""
    _ensure_anchor_products()
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    # วันแรกที่มีข้อมูลของแต่ละสินค้า ใช้หาว่ายังขาดประวัติย้อนหลังช่วงไหน
    first_loaded = dict(
        hook.get_records("SELECT product_id, MIN(price_date) FROM retail_prices_daily GROUP BY 1;")
    )
    session = build_http_session(total_retries=1)
    today = date.today()

    price_rows: list[tuple[Any, ...]] = []
    failures = 0
    products_ok: set[str] = set()
    products_failed_in_row = 0
    for product in ANCHOR_PRODUCTS:
        # Circuit breaker: ถ้าสินค้าล้มเหลวทั้งตัวติดกันหลายตัว แปลว่า API ล่ม ให้หยุดรอบนี้
        if products_failed_in_row >= MOC_MAX_CONSECUTIVE_FAILURES:
            print("API looks down; stop retail extraction for this run")
            break
        consecutive_failures = 0
        product_ok = False
        windows = _retail_windows(first_loaded.get(product["product_id"]), incremental, today)
        for window_start, window_end in windows:
            # ล้มติดกันหลายช่วงในสินค้าเดียว ให้ข้ามไปสินค้าถัดไป
            if consecutive_failures >= MOC_MAX_CONSECUTIVE_FAILURES:
                break
            try:
                response = session.get(
                    MOC_PRICE_URL,
                    params={
                        "product_id": product["product_id"],
                        "from_date": window_start.isoformat(),
                        "to_date": window_end.isoformat(),
                    },
                    timeout=MOC_TIMEOUT,
                )
                response.raise_for_status()
                payload = response.json()
            except (requests.RequestException, ValueError) as exc:
                consecutive_failures += 1
                failures += 1
                print(f"WARN MOC {product['product_id']} {window_start}: {exc}")
                continue
            consecutive_failures = 0
            product_ok = True
            write_json_gz(
                RAW_DIR / "moc" / product["product_id"] / f"{window_start}_{window_end}.json.gz",
                payload,
            )
            # อัปเดตชื่อจริงและหน่วยจาก API แทนชื่อสำรองที่ใส่ไว้
            hook.run(
                "UPDATE dim_product SET product_name = %s, unit = %s WHERE product_id = %s;",
                parameters=(
                    str(payload.get("product_name") or product["label"]).strip(),
                    payload.get("unit"),
                    product["product_id"],
                ),
            )
            for item in payload.get("price_list") or []:
                try:
                    price_date = datetime.fromisoformat(item["date"]).date()
                    low = finite_float(item["price_min"], "price_min")
                    high = finite_float(item["price_max"], "price_max")
                except (KeyError, TypeError, ValueError):
                    continue
                if 0 <= low <= high:
                    price_rows.append((product["product_id"], price_date, low, high))
                    products_ok.add(product["product_id"])
        products_failed_in_row = 0 if product_ok else products_failed_in_row + 1

    loaded = bulk_upsert(
        "retail_prices_daily",
        ["product_id", "price_date", "price_min", "price_max"],
        ["product_id", "price_date"],
        price_rows,
    )
    if not products_ok:
        status = "unavailable"
    elif failures:
        status = "partial"
    else:
        status = "ok"
    log_load(context, "moc_retail_prices", loaded, f"status={status} failures={failures}")
    result = {
        "source": "moc_retail_prices",
        "status": status,
        "record_count": loaded,
        "products_with_data": len(products_ok),
        "failed_requests": failures,
    }
    print(f"Extracted {result}")
    return result


# ---------------------------------------------------------------------------
# แหล่งข้อมูลที่ 3-4: ไฟล์ CSV บน data.go.th
# ---------------------------------------------------------------------------
def _resolve_csv_url(session: requests.Session, package_id: str) -> str:
    """ถาม CKAN API ว่าไฟล์ CSV ล่าสุดของชุดข้อมูลอยู่ที่ URL ใด."""
    response = session.get(DATA_GO_TH_PACKAGE_URL, params={"id": package_id}, timeout=(10, 60))
    response.raise_for_status()
    resources = response.json()["result"]["resources"]
    for resource in resources:
        if (resource.get("format") or "").upper() == "CSV" and resource.get("url"):
            return resource["url"]
    raise ValueError(f"No CSV resource in package {package_id}")


def _download_csv(session: requests.Session, url: str, cache_name: str) -> list[dict[str, str]]:
    """ดาวน์โหลด CSV และเดา encoding (หน่วยงานรัฐบางแห่งใช้ TIS-620)."""
    response = session.get(url, timeout=(10, 90))
    response.raise_for_status()
    content = response.content
    if content.lstrip().startswith(b"<"):
        raise ValueError(f"Expected CSV but received HTML from {url}")
    (RAW_DIR / "datagoth").mkdir(parents=True, exist_ok=True)
    (RAW_DIR / "datagoth" / cache_name).write_bytes(content)
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp874")  # cp874 คือ TIS-620 ที่รองรับตัวอักษรเพิ่ม
    return list(csv.DictReader(io.StringIO(text)))


def extract_farm_prices(**context: Any) -> dict[str, Any]:
    """ดึงราคาสินค้าปศุสัตว์ที่เกษตรกรขายได้ รายเดือน (กรมปศุสัตว์)."""
    session = build_http_session(total_retries=2)
    try:
        url = _resolve_csv_url(session, FARM_PRICE_PACKAGE)
        records = _download_csv(session, url, "farm_prices.csv")
    except (requests.RequestException, ValueError, KeyError) as exc:
        print(f"WARN farm prices unavailable: {exc}")
        return {"source": "dld_farm_prices", "status": "unavailable", "record_count": 0}

    rows = []
    for item in records:
        try:
            month = THAI_MONTHS[item["month"].strip()]
            period = date(be_to_ce(int(item["year"])), month, 1)
            price = finite_float(item["value"], "farm price")
        except (KeyError, TypeError, ValueError):
            continue
        rows.append((item["particular"].strip(), period, price, (item.get("unit") or "").strip()))

    loaded = bulk_upsert(
        "farm_prices_monthly",
        ["item_name", "period_date", "price", "unit"],
        ["item_name", "period_date"],
        rows,
    )
    log_load(context, "dld_farm_prices", loaded)
    result = {"source": "dld_farm_prices", "status": "ok" if loaded else "empty", "record_count": loaded}
    print(f"Extracted {result}")
    return result


def extract_minimum_wage(**context: Any) -> dict[str, Any]:
    """ดึงค่าจ้างขั้นต่ำรายจังหวัดของกระทรวงแรงงาน และรวมกับไฟล์ที่เติมเอง."""
    session = build_http_session(total_retries=2)
    rows: list[tuple[Any, ...]] = []
    problems = []
    for package_id, valid_until_text in MINIMUM_WAGE_PACKAGES.items():
        valid_until = date.fromisoformat(valid_until_text) if valid_until_text else None
        try:
            url = _resolve_csv_url(session, package_id)
            records = _download_csv(session, url, f"minimum_wage_{package_id}.csv")
        except (requests.RequestException, ValueError, KeyError) as exc:
            problems.append(f"{package_id}: {exc}")
            continue
        for item in records:
            try:
                code = str(int(item["PROV_CODE"]))
                wage = finite_float(item["MIN_WAGES"], "MIN_WAGES")
                effective = parse_thai_date(item["EFFECT_DD"])
            except (KeyError, TypeError, ValueError):
                continue
            rows.append(
                (code, item["PROVINCE_NAME"].strip(), effective, valid_until, wage,
                 f"สำนักงานปลัดกระทรวงแรงงาน (data.go.th/{package_id})")
            )

    # ไฟล์เติมเอง: province_code,province_name,effective_date,valid_until,daily_wage,source
    if MINIMUM_WAGE_EXTRA_CSV.exists():
        with MINIMUM_WAGE_EXTRA_CSV.open(encoding="utf-8-sig") as handle:
            for item in csv.DictReader(handle):
                try:
                    rows.append(
                        (
                            str(int(item["province_code"])),
                            item["province_name"].strip(),
                            date.fromisoformat(item["effective_date"].strip()),
                            date.fromisoformat(item["valid_until"].strip())
                            if (item.get("valid_until") or "").strip() else None,
                            finite_float(item["daily_wage"], "daily_wage"),
                            item["source"].strip() or "seed file",
                        )
                    )
                except (KeyError, TypeError, ValueError) as exc:
                    problems.append(f"seed row skipped: {exc}")

    loaded = bulk_upsert(
        "minimum_wage",
        ["province_code", "province_name", "effective_date", "valid_until", "daily_wage", "source"],
        ["province_code", "effective_date"],
        rows,
    )
    log_load(context, "mol_minimum_wage", loaded, "; ".join(problems))
    status = "ok" if loaded and not problems else ("partial" if loaded else "unavailable")
    result = {
        "source": "mol_minimum_wage",
        "status": status,
        "record_count": loaded,
        "problems": problems[:5],
    }
    print(f"Extracted {result}")
    return result
