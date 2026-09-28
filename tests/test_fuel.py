"""ทดสอบตัวอ่านผลลัพธ์ SOAP ราคาน้ำมันของ ปตท. (ไม่ต่อเน็ต ใช้ XML ตัวอย่าง)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from col_11_fuel import parse_oil_response  # noqa: E402

# ผลลัพธ์จริงเป็น XML ที่ถูก escape ซ้อนอยู่ใน <GetOilPriceResult>
SAMPLE = (
    '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">'
    "<soap:Body><GetOilPriceResponse><GetOilPriceResult>"
    "&lt;PTTOR_DS&gt;&lt;FUEL&gt;&lt;PRODUCT&gt;Diesel&lt;/PRODUCT&gt;&lt;PRICE&gt;40.69&lt;/PRICE&gt;&lt;/FUEL&gt;"
    "&lt;FUEL&gt;&lt;PRODUCT&gt;Gasohol 95&lt;/PRODUCT&gt;&lt;PRICE&gt;39.94&lt;/PRICE&gt;&lt;/FUEL&gt;"
    "&lt;FUEL&gt;&lt;PRODUCT&gt;Broken&lt;/PRODUCT&gt;&lt;PRICE&gt;n/a&lt;/PRICE&gt;&lt;/FUEL&gt;&lt;/PTTOR_DS&gt;"
    "</GetOilPriceResult></GetOilPriceResponse></soap:Body></soap:Envelope>"
)


def test_parse_oil_response_reads_escaped_prices():
    assert parse_oil_response(SAMPLE) == {"Diesel": 40.69, "Gasohol 95": 39.94}


def test_parse_oil_response_empty_day():
    empty = "<GetOilPriceResult><PTTOR_DS></PTTOR_DS></GetOilPriceResult>"
    assert parse_oil_response(empty) == {}
