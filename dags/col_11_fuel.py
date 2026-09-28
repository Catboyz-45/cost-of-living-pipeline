"""ขั้นที่ 11: ราคาขายปลีกน้ำมันรถจริงเป็นบาท จาก Web Service ของ ปตท.

Web Service `GetOilPrice` (SOAP) คืนราคาขายปลีกหน้าปั๊มในกรุงเทพฯ ของวันที่ขอ
มีข้อมูลตั้งแต่ 1 ม.ค. 2565 และขอได้ทีละวัน จึง:
- เก็บผลเป็นไฟล์ cache รายเดือนใน Bronze layer เดือนที่จบไปแล้วไม่ยิงซ้ำ
- เว้นระยะทุก request ไม่ให้เป็นภาระกับเซิร์ฟเวอร์
- ถ้าเซิร์ฟเวอร์ล่มจะคืนสถานะผ่าน XCom โดยไม่ทำให้ DAG fail
ราคาน้ำมันเก็บในตารางเดียวกับราคาขายปลีกอาหาร (retail_prices_daily) โดยราคาต่ำสุด = สูงสุด
"""

import html
import re
import time
from datetime import date, timedelta
from typing import Any

import requests
from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import (
    FUEL_CPI_CODE,
    FUEL_PRODUCTS,
    MOC_TIMEOUT,
    POSTGRES_CONN_ID,
    PTT_OIL_START,
    PTT_OIL_URL,
    PTT_PAUSE_SECONDS,
    RAW_DIR,
)
from col_01_utils import build_http_session, finite_float, iter_months, read_json_gz, write_json_gz
from col_02_database import bulk_upsert, log_load

SOAP_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
    '<GetOilPrice xmlns="http://www.pttor.com"><Language>en</Language>'
    "<DD>{day}</DD><MM>{month}</MM><YYYY>{year}</YYYY></GetOilPrice>"
    "</soap:Body></soap:Envelope>"
)
PRICE_PATTERN = re.compile(r"<PRODUCT>(.*?)</PRODUCT>\s*<PRICE>(.*?)</PRICE>", re.S)
MAX_CONSECUTIVE_FAILURES = 5


def parse_oil_response(text: str) -> dict[str, float]:
    """ผลลัพธ์เป็น XML ที่ escape ซ้อนอยู่ใน SOAP จึง unescape ก่อนแล้วอ่านคู่ สินค้า-ราคา."""
    prices = {}
    for product, price in PRICE_PATTERN.findall(html.unescape(text)):
        try:
            value = finite_float(price, "price")
        except ValueError:
            continue
        if 0 < value < 500:
            prices[product.strip()] = value
    return prices


def _fetch_day(session: requests.Session, day: date) -> dict[str, float]:
    time.sleep(PTT_PAUSE_SECONDS)
    response = session.post(
        PTT_OIL_URL,
        data=SOAP_BODY.format(day=day.day, month=day.month, year=day.year).encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": '"http://www.pttor.com/GetOilPrice"'},
        timeout=MOC_TIMEOUT,
    )
    response.raise_for_status()
    return parse_oil_response(response.text)


def extract_fuel_prices(**context: Any) -> dict[str, Any]:
    """ดึงราคาน้ำมันรายวันตั้งแต่ปี 2565 (ใช้ cache รายเดือน) แล้วโหลดเข้า retail_prices_daily."""
    session = build_http_session(total_retries=2)
    today = date.today()
    start = date.fromisoformat(PTT_OIL_START)
    stats = {"requests": 0, "cache_months": 0, "failed_requests": 0}
    consecutive_failures = 0
    price_rows: list[tuple[Any, ...]] = []

    for year, month in iter_months((start.year, start.month), (today.year, today.month)):
        month_start = date(year, month, 1)
        next_month = date(year + (month == 12), month % 12 + 1, 1)
        cache = RAW_DIR / "ptt_oil" / f"{year}-{month:02d}.json.gz"
        # เดือนที่จบไปแล้วอย่างน้อย 1 เดือนเต็ม ราคาไม่เปลี่ยนอีก ใช้ cache ได้
        stable = next_month + timedelta(days=31) <= today
        if stable and cache.exists():
            days = read_json_gz(cache)
            stats["cache_months"] += 1
        else:
            days = read_json_gz(cache) if cache.exists() else {}
            day = month_start
            while day < next_month and day <= today:
                key = day.isoformat()
                # วันที่เคยได้ราคาแล้วไม่ต้องขอซ้ำ (ยกเว้นวันนี้ที่ราคาอาจเปลี่ยนตอนเช้า)
                if key not in days or day == today:
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                        break
                    try:
                        days[key] = _fetch_day(session, day)
                        stats["requests"] += 1
                        consecutive_failures = 0
                    except requests.RequestException as exc:
                        stats["failed_requests"] += 1
                        consecutive_failures += 1
                        print(f"WARN PTT {key}: {exc}")
                day += timedelta(days=1)
            write_json_gz(cache, days)
        for key, prices in days.items():
            for ptt_name, (product_id, _) in FUEL_PRODUCTS.items():
                if ptt_name in prices:
                    price_rows.append((product_id, date.fromisoformat(key), prices[ptt_name], prices[ptt_name]))
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            print("PTT service looks down; stop this run")
            break

    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    for product_id, name in FUEL_PRODUCTS.values():
        hook.run(
            """
            INSERT INTO dim_product (product_id, product_name, label, unit, cpi_code, product_group, source)
            VALUES (%s, %s, %s, 'บาท/ลิตร', %s, 'น้ำมันเชื้อเพลิง', 'ptt_api')
            ON CONFLICT (product_id) DO UPDATE SET
                product_name = EXCLUDED.product_name, unit = EXCLUDED.unit,
                product_group = EXCLUDED.product_group, source = EXCLUDED.source;
            """,
            parameters=(product_id, name, name, FUEL_CPI_CODE),
        )
    loaded = bulk_upsert(
        "retail_prices_daily",
        ["product_id", "price_date", "price_min", "price_max"],
        ["product_id", "price_date"],
        price_rows,
    )
    status = "unavailable" if not price_rows else "partial" if stats["failed_requests"] else "ok"
    log_load(context, "ptt_fuel_prices", loaded, f"status={status} requests={stats['requests']}")
    result = {"source": "ptt_fuel_prices", "status": status, "record_count": loaded, **stats}
    print(f"Extracted {result}")
    return result
