"""สร้าง data/seed/minimum_wage_extra.csv จาก PDF ประกาศคณะกรรมการค่าจ้างของกระทรวงแรงงาน.

data.go.th มีตารางค่าจ้างขั้นต่ำครบ 77 จังหวัดเฉพาะปี 2556, 2560, 2563 ประกาศที่ใหม่กว่า
มีแต่เป็น PDF สคริปต์นี้อ่านตาราง "อัตรา / จำนวนจังหวัด / เขตท้องที่" ในแต่ละ PDF แล้ว
ตรวจว่าจำนวนจังหวัดที่จับคู่ได้ตรงกับตัวเลขในประกาศทุกกลุ่ม และรวมได้ 77 จังหวัดพอดี

ใช้ครั้งเดียวตอนเตรียมข้อมูล (ไม่ได้รันใน Airflow):
    1. ดาวน์โหลด PDF จากลิงก์ใน ANNOUNCEMENTS ไว้ในโฟลเดอร์เดียวกัน
    2. pip install pypdf==5.1.0
    3. python build_minimum_wage_seed.py <โฟลเดอร์ PDF> <provinces.csv> <ไฟล์ผลลัพธ์>
       provinces.csv = "รหัส,ชื่อจังหวัด" 77 แถว (ส่งออกจากตาราง minimum_wage)
"""

import csv
import re
import sys
from pathlib import Path

from pypdf import PdfReader

# (ไฟล์, วันที่มีผล, ลำดับคอลัมน์ในตาราง, แหล่งที่มา)
ANNOUNCEMENTS = [
    ("w09.pdf", "2018-04-01", "count_rate",
     "ประกาศคณะกรรมการค่าจ้าง ฉบับที่ 9 https://www.mol.go.th/wp-content/uploads/sites/2/2019/07/prakaaskhnakrrmkaarkhaacchaang_eruueng_atraakhaacchaangkhantam_chbabthii9_0.pdf"),
    ("w11.pdf", "2022-10-01", "rate_count",
     "ประกาศคณะกรรมการค่าจ้าง ฉบับที่ 11 https://www.mol.go.th/wp-content/uploads/sites/2/2022/09/PrakadWageMOL2565-11-for20Sep2565.pdf"),
    ("w12.pdf", "2024-01-01", "rate_count",
     "ประกาศคณะกรรมการค่าจ้าง ฉบับที่ 12 https://www.mol.go.th/wp-content/uploads/sites/2/2024/01/ประกาศคณะกรรมการค่าจ้างขั้นต่ำ-ฉ.12.pdf"),
    ("w13.pdf", "2025-01-01", "rate_count",
     "ประกาศคณะกรรมการค่าจ้าง ฉบับที่ 13 https://www.mol.go.th/wp-content/uploads/sites/2/2024/12/ประกาศค่าจ้างขั้นต่ำ-ฉ13ราชกิจจา.pdf"),
]
# ฉบับที่ 14 (ราชกิจจานุเบกษา 1 ก.ค. 2568) ใช้ฟอนต์ที่อ่านข้อความไม่ได้ และปรับอัตราทั่วไป
# เฉพาะกรุงเทพมหานครเป็น 400 บาท (อีกสองกลุ่มเป็นกิจการโรงแรม/สถานบริการ ไม่ใช่อัตราทั่วไป)
EXTRA_ROWS = [
    ("10", "กรุงเทพมหานคร", "2025-07-01", "", 400,
     "ประกาศคณะกรรมการค่าจ้าง ฉบับที่ 14 https://ratchakitcha.soc.go.th/documents/76681.pdf "
     "และ https://www.prd.go.th/th/content/category/detail/id/39/iid/402570"),
]
MARKS = "ัิีึืุู็่้๊๋์ํ"


def normalize(text: str) -> str:
    """ตัดวรรณยุกต์/สระบนล่างและช่องว่าง เพราะ PDF มักทำให้ตัวอักษรเหล่านี้หายหรือแตก."""
    text = text.replace("ำ", "า")
    text = "".join(character for character in text if character not in MARKS)
    return re.sub(r"\s+", "", text)


def parse_table(text: str, order: str, provinces: dict[str, str]) -> dict[str, int]:
    canonical = sorted(((normalize(name), code) for code, name in provinces.items()), key=lambda x: -len(x[0]))
    head = re.compile(r"^\s*(\d{1,2})\s+(\d{1,3})\s+(\d{1,3})\s*(.*)$")
    groups, current = [], None
    for line in text.splitlines():
        match = head.match(line)
        if match:
            first, second = int(match.group(2)), int(match.group(3))
            rate, count = (first, second) if order == "rate_count" else (second, first)
            if 250 <= rate <= 500:
                current = {"rate": rate, "count": count, "text": match.group(4)}
                groups.append(current)
                continue
        if current is not None:
            if re.search(r"หมายเหตุ|ตารางแสดง|สำนักงานปลัด|^\s*\d{1,2}\s*$", line):
                current = None
                continue
            current["text"] += " " + line

    rates: dict[str, int] = {}
    for group in groups:
        # PDF ใช้ glyph ใน Private Use Area แทนวรรณยุกต์ ต้องตัดออกก่อน
        text = re.sub(r"[-]", "", group["text"])
        district_only = bool(re.match(r"^\s*อำเภอ", text))
        # อัตราเฉพาะอำเภอไม่ใช่อัตราทั่วไปของจังหวัด จึงตัดออก (ใช้ส่วน "ยกเว้นอำเภอ" แทน)
        text = re.sub(r"เฉพาะอำเภอ\S+\s*จังหวัด\S+", " ", text)
        text = re.sub(r"ยกเว้?นอำเภอ\S+", " ", text)
        text = re.sub(r"^\s*อำเภอ|\d+\s*อำเภอ", " ", text)
        remaining = normalize(text).replace("จงหวด", "").replace("และ", "")
        found = []
        for name, code in canonical:
            if name in remaining:
                remaining = remaining.replace(name, "|")
                found.append(code)
        expected = 0 if district_only else group["count"]
        leftover = remaining.replace("|", "")
        if len(found) != expected or leftover:
            raise ValueError(f"rate {group['rate']}: expected {expected}, found {len(found)}, leftover {leftover!r}")
        for code in found:
            if code in rates:
                raise ValueError(f"province {code} appears twice")
            rates[code] = group["rate"]
    if len(rates) != len(provinces):
        raise ValueError(f"only {len(rates)} of {len(provinces)} provinces parsed")
    return rates


def main(pdf_dir: str, provinces_csv: str, output_csv: str) -> None:
    provinces = {code: name for code, name in csv.reader(open(provinces_csv, encoding="utf-8"))}
    rows = []
    for file_name, effective, order, source in ANNOUNCEMENTS:
        text = "".join(page.extract_text() or "" for page in PdfReader(Path(pdf_dir) / file_name).pages)
        rates = parse_table(text, order, provinces)
        rows += [(code, provinces[code], effective, "", rate, source) for code, rate in sorted(rates.items())]
        print(f"{file_name}: {len(rates)} provinces, {min(rates.values())}-{max(rates.values())} baht")
    rows += EXTRA_ROWS
    with open(output_csv, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["province_code", "province_name", "effective_date", "valid_until", "daily_wage", "source"])
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows to {output_csv}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
