"""ทดสอบตัวอ่าน HTML ของหน้าค้นหาราคากรมการค้าภายใน (ไม่ต่อเน็ต ใช้ HTML ตัวอย่าง)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from col_10_scrape import cpi_code_for, parse_price_page  # noqa: E402

# โครงสร้างย่อจากหน้าจริง: ตารางสรุปสินค้าที่มีตารางราคาซ้อนอยู่ข้างใน และตารางราคาซ้ำอีกชุด
SAMPLE_HTML = """
<html><body>
<table>
  <tr><td>ชื่อสินค้า (product_name)</td><td>คืนค่าเป็นตัวอักษร "String"</td></tr>
</table>
<table>
  <tr><td>รหัสสินค้า</td><td>P13001</td></tr>
  <tr><td>ชื่อสินค้า</td><td>ผักคะน้า คละ</td></tr>
  <tr><td>หมวดหมู่สินค้า</td><td>ขายปลีก</td></tr>
  <tr><td>กลุ่มสินค้า</td><td>ผักสด</td></tr>
  <tr><td>หน่วย</td><td>บาท/ กก.</td></tr>
  <tr><td colspan="2">
    <table>
      <tr><th>วันที่สำรวจการขาย</th><th>ราคาต่ำสุด (บาท)</th><th>ราคาสูงสุด (บาท)</th></tr>
      <tr><td>9/1/2026</td><td>25</td><td>30</td></tr>
      <tr><td>9/2/2026</td><td>1,250.50</td><td>1,300</td></tr>
    </table>
  </td></tr>
</table>
<table>
  <tr><td>9/1/2026</td><td>25</td><td>30</td></tr>
</table>
</body></html>
"""


def test_parse_price_page_reads_meta_and_rows():
    page = parse_price_page(SAMPLE_HTML)
    assert page["meta"] == {"name": "ผักคะน้า คละ", "category": "ขายปลีก", "group": "ผักสด", "unit": "บาท/ กก."}
    # แถวซ้ำจากตารางที่สองถูกตัดออก และวันที่แปลงจาก เดือน/วัน/ปี เป็น ISO
    assert page["rows"] == [["2026-09-01", "25", "30"], ["2026-09-02", "1,250.50", "1,300"]]


def test_parse_price_page_without_results():
    assert parse_price_page("<html><body><p>ไม่พบข้อมูล</p></body></html>") == {"meta": {}, "rows": []}


def test_cpi_code_mapping():
    assert cpi_code_for("P11028", "ไข่ไก่ เบอร์ 3") == "11310"
    assert cpi_code_for("P11010", "ไก่สดทั้งตัว (ไม่รวมเครื่องใน)") == "11221"
    assert cpi_code_for("P11003", "สุกรชำแหละ เนื้อแดง สะโพก (ตัดแต่ง)") == "11211"
    assert cpi_code_for("P12014", "ปลาทูสด (9-12 ตัว/กก.)") == "11232"
    assert cpi_code_for("P12001", "กุ้งขาว (40 ตัว/กก.)") == "11233"
    assert cpi_code_for("P12017", "ปลานิล") == "11231"
    assert cpi_code_for("P16011", "น้ำมันปาล์มสำเร็จรูป บรรจุขวด1 ลิตร") == "11521"
    assert cpi_code_for("R13001", "ข้าวสารเจ้า 100% ข้าวหอม ร้านค้าทั่วไป") == "11110"
    assert cpi_code_for("P13001", "ผักคะน้า คละ") == "11411"
