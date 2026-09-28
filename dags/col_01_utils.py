"""ขั้นที่ 01: ฟังก์ชันเล็ก ๆ ที่หลาย Task ใช้ร่วมกัน."""

import gzip
import json
import math
import re
from datetime import date
from pathlib import Path
from typing import Any, Iterator

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ชื่อเดือนภาษาไทยแบบย่อที่พบในไฟล์ของหน่วยงานรัฐ เช่น "1-เม.ย.-55", "1 ม.ค. 63"
THAI_MONTHS = {
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
}


def finite_float(value: Any, field_name: str) -> float:
    """แปลงค่าเป็น float และไม่ยอมรับค่าว่าง, NaN หรือ Infinity."""
    try:
        # API อาจส่งตัวเลขมาเป็น string หรือมีเครื่องหมายจุลภาคคั่นหลักพัน
        result = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid numeric value for {field_name}") from exc
    if not math.isfinite(result):
        raise ValueError(f"Non-finite numeric value for {field_name}")
    return result


def be_to_ce(year_be: int) -> int:
    """แปลงปี พ.ศ. เป็น ค.ศ. (API ของ สนค. ใช้ พ.ศ.)."""
    return int(year_be) - 543


def ce_to_be(year_ce: int) -> int:
    """แปลงปี ค.ศ. เป็น พ.ศ."""
    return int(year_ce) + 543


def iter_months(start: tuple[int, int], end: tuple[int, int]) -> Iterator[tuple[int, int]]:
    """วนทีละเดือนแบบรวมหัวท้าย รับและคืนค่าเป็น (ปี, เดือน)."""
    year, month = start
    while (year, month) <= end:
        yield year, month
        month += 1
        if month == 13:
            year, month = year + 1, 1


def shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    """เลื่อนเดือนไปข้างหน้า (+) หรือย้อนหลัง (-) ตามจำนวนที่กำหนด."""
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def parse_thai_date(text: str) -> date:
    """อ่านวันที่แบบไทย เช่น "1-เม.ย.-55" หรือ "1 ม.ค. 63" เป็น date (ค.ศ.)."""
    match = re.match(r"^\s*(\d{1,2})[\s-]*([ก-๙.]+)[\s-]*(\d{2,4})\s*$", text or "")
    if not match:
        raise ValueError(f"Unrecognised Thai date: {text!r}")
    day, month_text, year_text = match.groups()
    month = THAI_MONTHS.get(month_text)
    if month is None:
        raise ValueError(f"Unrecognised Thai month: {month_text!r}")
    year_be = int(year_text)
    # ปีสองหลัก เช่น 55 หมายถึง พ.ศ. 2555
    if year_be < 100:
        year_be += 2500
    return date(be_to_ce(year_be), month, int(day))


def build_http_session(total_retries: int = 4) -> requests.Session:
    """สร้าง Session ที่ลองใหม่อัตโนมัติเมื่อเจอ 429/5xx พร้อม backoff."""
    retry = Retry(
        total=total_retries,
        backoff_factor=2,  # รอ 2, 4, 8 ... วินาทีระหว่างการลองใหม่
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],  # POST ของ สนค. เป็นการอ่านข้อมูล จึงลองซ้ำได้
        raise_on_status=False,
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers["User-Agent"] = "thai-cost-of-living-airflow/1.0 (student project)"
    return session


def read_json_gz(path: Path) -> Any:
    """อ่านไฟล์ JSON ที่บีบอัดด้วย gzip จาก Bronze layer."""
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_gz(path: Path, payload: Any) -> None:
    """เขียน JSON แบบ gzip โดยเขียนไฟล์ชั่วคราวก่อนแล้วค่อย rename (atomic)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    temporary.replace(path)
