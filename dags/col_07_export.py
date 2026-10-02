"""ขั้นที่ 07: Export ตารางสรุปเป็น CSV และ Excel สำหรับอัปโหลดเข้า Power BI (เว็บ).

Power BI บนเว็บต่อ PostgreSQL บนเครื่องเราโดยตรงไม่ได้ (ต้องมี gateway บน Windows)
จึงให้ Airflow สร้างไฟล์ขนาดพอเหมาะไว้ในโฟลเดอร์ ./exports แทน

- CSV: หนึ่งไฟล์ต่อหนึ่งตาราง ใช้ดูหรือเปิดใน Excel ได้ทันที
- Excel: รวมทุกตารางเป็น sheet ในไฟล์เดียว เพราะ Power BI บนเว็บสร้าง
  semantic model หนึ่งตัวต่อหนึ่งไฟล์ ถ้าอัปโหลด CSV หลายไฟล์จะโยง
  Relationship ข้ามตารางไม่ได้ แต่ไฟล์ Excel ไฟล์เดียวทำได้
"""

import csv
import json
import os
from datetime import datetime
from typing import Any

from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import EXPORT_DIR, ML_MAX_LEVEL, POSTGRES_CONN_ID

EXCEL_FILE = "cost_of_living_powerbi.xlsx"
# ฉบับย่อสำหรับ Power BI บนเว็บ: Power BI นำเข้า Excel จาก OneDrive ได้ไม่เกินราว 30 MB
# (ไฟล์เต็มเกินจะขึ้น ExcelViewWorkbookExceedsMaximiumSize) จึงตัดเหลือหมวดระดับ 1–2 และช่วงเวลาล่าสุด
EXCEL_LITE_FILE = "cost_of_living_powerbi_lite.xlsx"
LITE_MAX_LEVEL = 2
LITE_FROM_YEAR = 2016                # ดัชนีภาคและรายปี ตั้งแต่ปีนี้
LITE_PROVINCE_MONTHS = 24            # ดัชนีจังหวัด กี่เดือนล่าสุด
EXCEL_MAX_ROWS = 1_048_575  # จำนวนแถวสูงสุดต่อ sheet ของ Excel (ไม่นับหัวตาราง)
TEXT_COLUMNS = {
    "area_key", "area_code", "commodity_code", "province_code",
    "product_id", "cpi_code", "region_code",
}

# ชื่อภาคภาษาไทยของรหัสภาคในดัชนี สนค.
REGION_NAMES_SQL = """
CASE a.region_code
    WHEN 'TG' THEN 'ทั้งประเทศ'
    WHEN '10' THEN 'กรุงเทพฯ และปริมณฑล'
    WHEN 'CC' THEN 'ภาคกลาง'
    WHEN 'NN' THEN 'ภาคเหนือ'
    WHEN 'EE' THEN 'ภาคตะวันออกเฉียงเหนือ'
    WHEN 'SS' THEN 'ภาคใต้'
END
"""

# ชื่อไฟล์ -> SQL ; ทุกไฟล์มีคีย์ area_key หรือ commodity_code ไว้ทำ Relationship ใน Power BI
EXPORT_QUERIES = {
    "dim_area.csv": f"""
        SELECT a.area_type || ':' || a.area_code AS area_key, a.area_type, a.area_code,
               a.area_name, a.region_code, {REGION_NAMES_SQL} AS region_name,
               'Thailand' AS country
        FROM dim_area a ORDER BY a.area_type, a.area_code
    """,
    "dim_commodity.csv": """
        SELECT commodity_code, commodity_name, level FROM dim_commodity
        WHERE level <= {max_level} ORDER BY commodity_code
    """,
    "dim_product.csv": """
        SELECT product_id, label, product_name, unit, cpi_code, product_group, source
        FROM dim_product ORDER BY product_id
    """,
    # ราคาจริงรายเดือนจาก web scraping + API ของกรมการค้าภายใน
    "fact_retail_price_monthly.csv": """
        SELECT m.product_id, p.label, p.unit, p.product_group, m.period_date,
               m.avg_price, m.low_price, m.high_price, m.days_observed
        FROM retail_price_monthly m JOIN dim_product p USING (product_id)
        ORDER BY 1, 5
    """,
    # ประเทศและภาค: ทุกเดือนย้อนหลังตั้งแต่ปี 2519
    "fact_cpi_region_monthly.csv": """
        SELECT c.area_type || ':' || c.area_code AS area_key, c.commodity_code, c.period_date,
               c.index_value, c.change_mom, c.change_yoy
        FROM cpi_monthly c JOIN dim_commodity d USING (commodity_code)
        WHERE c.area_type = 'region' AND d.level <= {max_level}
        ORDER BY 1, 2, 3
    """,
    # จังหวัด: เฉพาะ 36 เดือนล่าสุด เพื่อให้ไฟล์ไม่ใหญ่เกินไปสำหรับอัปโหลด
    "fact_cpi_province_monthly_recent.csv": """
        SELECT c.area_type || ':' || c.area_code AS area_key, c.commodity_code, c.period_date,
               c.index_value, c.change_mom, c.change_yoy
        FROM cpi_monthly c JOIN dim_commodity d USING (commodity_code)
        WHERE c.area_type = 'province' AND d.level <= {max_level}
          AND c.period_date > (SELECT MAX(period_date) FROM cpi_monthly) - INTERVAL '36 months'
        ORDER BY 1, 2, 3
    """,
    "fact_cpi_yearly.csv": """
        SELECT s.area_type || ':' || s.area_code AS area_key, s.commodity_code, s.year_ce,
               s.year_ce + 543 AS year_be, s.avg_index, s.yoy_pct, s.months_covered
        FROM cpi_yearly_summary s JOIN dim_commodity d USING (commodity_code)
        WHERE d.level <= {max_level}
        ORDER BY 1, 2, 3
    """,
    # ผลพยากรณ์ล่าสุดของแต่ละ series
    "fact_forecast.csv": """
        SELECT f.area_type || ':' || f.area_code AS area_key, f.commodity_code,
               f.base_period, f.target_period, f.base_index, f.predicted_index,
               f.predicted_change_pct,
               CASE WHEN f.predicted_change_pct > 0.05 THEN 'ขึ้น'
                    WHEN f.predicted_change_pct < -0.05 THEN 'ลง' ELSE 'ทรงตัว' END AS direction,
               f.model_name, f.predicted_at
        FROM cpi_forecasts f
        WHERE f.target_period = (SELECT MAX(target_period) FROM cpi_forecasts)
        ORDER BY 1, 2
    """,
    "fact_price_estimates.csv": """
        SELECT e.product_id, p.label, p.unit, e.period_date, e.actual_price,
               e.estimated_price, e.anchor_period, e.anchor_price
        FROM price_estimates e JOIN dim_product p USING (product_id)
        ORDER BY 1, 4
    """,
    # ค่าแรงที่แท้จริง + ไข่ไก่เบอร์ 3 ที่ซื้อได้ด้วยค่าแรง 1 วัน (กรณีมีราคาอ้างอิง)
    "fact_real_wage.csv": """
        SELECT CASE WHEN w.province_code = '10' THEN 'region:10'
                    ELSE 'province:' || w.province_code END AS area_key,
               w.province_code, m.province_name, w.period_date, w.nominal_wage,
               w.cpi_all_items, w.cpi_food, w.real_wage,
               w.nominal_wage / NULLIF(egg.estimated_price, 0) AS eggs_per_day_wage
        FROM real_wage_monthly w
        JOIN LATERAL (
            SELECT province_name FROM minimum_wage mw
            WHERE mw.province_code = w.province_code
            ORDER BY effective_date DESC LIMIT 1
        ) m ON TRUE
        LEFT JOIN price_estimates egg
          ON egg.product_id = 'P11028' AND egg.period_date = w.period_date
        ORDER BY 2, 4
    """,
    "fact_farm_prices.csv": """
        SELECT item_name, period_date, price, unit FROM farm_prices_monthly ORDER BY 1, 2
    """,
    "fact_farm_retail_correlation.csv": """
        SELECT farm_item, cpi_code AS commodity_code, lag_months, pearson_correlation, sample_size
        FROM farm_retail_correlation
        WHERE calculated_at = (SELECT MAX(calculated_at) FROM farm_retail_correlation)
        ORDER BY 1, 3
    """,
    # ทายไว้ vs เกิดจริง ของโมเดลที่ใช้งานจริง (เดือนที่โมเดลไม่เคยเห็นตอนเทรน)
    "fact_model_backtest.csv": """
        SELECT area_type || ':' || area_code AS area_key, commodity_code, base_period, target_period,
               predicted_change_pct, actual_change_pct, model_trained_through
        FROM cpi_backtest ORDER BY 1, 2, 4
    """,
    "model_metrics.csv": """
        SELECT run_at, model_name, rmse, mae, r2, baseline_rmse, direction_accuracy,
               training_rows, holdout_rows, deployed
        FROM cpi_model_metrics ORDER BY run_at
    """,
    # การ์ดโชว์ปริมาณข้อมูลใน dashboard
    "data_volume.csv": """
        SELECT 'cpi_monthly' AS table_name, COUNT(*) AS row_count FROM cpi_monthly
        UNION ALL SELECT 'retail_prices_daily', COUNT(*) FROM retail_prices_daily
        UNION ALL SELECT 'retail_price_monthly', COUNT(*) FROM retail_price_monthly
        UNION ALL SELECT 'farm_prices_monthly', COUNT(*) FROM farm_prices_monthly
        UNION ALL SELECT 'minimum_wage', COUNT(*) FROM minimum_wage
        UNION ALL SELECT 'cpi_forecasts', COUNT(*) FROM cpi_forecasts
    """,
}


def export_powerbi(**_: Any) -> dict[str, Any]:
    """เขียนทุกไฟล์ใน EXPORT_QUERIES และสร้าง manifest.json สรุปจำนวนแถว."""
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    connection = hook.get_conn()
    manifest: dict[str, Any] = {"generated_at": datetime.now().isoformat(), "files": {}}
    try:
        with connection.cursor() as cursor:
            for file_name, query in EXPORT_QUERIES.items():
                sql = query.format(max_level=int(ML_MAX_LEVEL)).strip()
                cursor.execute(f"SELECT COUNT(*) FROM ({sql}) AS counted;")
                row_count = cursor.fetchone()[0]
                target = EXPORT_DIR / file_name
                temporary = EXPORT_DIR / f".{file_name}.tmp"
                # utf-8-sig ใส่ BOM ให้ Power BI/Excel อ่านภาษาไทยถูกต้อง
                with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
                    cursor.copy_expert(f"COPY ({sql}) TO STDOUT WITH CSV HEADER", handle)
                # เปลี่ยนชื่อทีเดียว คนที่เปิดไฟล์อยู่จะไม่เห็นไฟล์ที่เขียนไม่เสร็จ
                os.replace(temporary, target)
                manifest["files"][file_name] = {
                    "rows": int(row_count),
                    "bytes": target.stat().st_size,
                }
    finally:
        connection.close()

    manifest["excel"] = _write_excel(manifest["files"])
    manifest["excel_lite"] = _write_excel(manifest["files"], EXCEL_LITE_FILE, _lite_filter())
    (EXPORT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Exported {len(manifest['files'])} files to {EXPORT_DIR}")
    return {name: info["rows"] for name, info in manifest["files"].items()}


def _excel_value(column: str, text: str) -> Any:
    """แปลงข้อความจาก CSV เป็นชนิดที่ถูกต้องใน Excel."""
    if text == "":
        return None
    # รหัสต้องเป็นข้อความ ไม่เช่นนั้น "01" จะกลายเป็นเลข 1
    if column in TEXT_COLUMNS:
        return text
    if column.endswith(("_date", "_period")):
        try:
            return datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError:
            return text
    try:
        return float(text)
    except ValueError:
        return text


def _lite_filter() -> Any:
    """ตัวกรองแถวของไฟล์ฉบับย่อ: เก็บหมวดระดับ 1–2 และช่วงเวลาล่าสุดของตารางดัชนีขนาดใหญ่."""
    with (EXPORT_DIR / "dim_commodity.csv").open(encoding="utf-8-sig", newline="") as handle:
        levels = {row["commodity_code"]: int(row["level"]) for row in csv.DictReader(handle)}
    # นับย้อนจากเดือนล่าสุดที่มีข้อมูลจังหวัด (ไม่ใช่วันนี้ เพราะ สนค. ประกาศช้ากว่า 1–2 เดือน)
    with (EXPORT_DIR / "fact_cpi_province_monthly_recent.csv").open(encoding="utf-8-sig", newline="") as handle:
        latest = max((row["period_date"][:7] for row in csv.DictReader(handle)), default="9999-12")
    year, month = int(latest[:4]), int(latest[5:7])
    months = year * 12 + month - 1 - (LITE_PROVINCE_MONTHS - 1)
    province_from = f"{months // 12:04d}-{months % 12 + 1:02d}"
    since = {
        "fact_cpi_region_monthly.csv": ("period_date", f"{LITE_FROM_YEAR}-01"),
        "fact_cpi_province_monthly_recent.csv": ("period_date", province_from),
        "fact_cpi_yearly.csv": ("year_ce", str(LITE_FROM_YEAR)),
    }

    # ตัดหมวดระดับ 3 เฉพาะตารางดัชนีที่ใหญ่ ตารางเล็ก (เช่น correlation ที่ใช้หมวดย่อย) เก็บครบ
    big_tables = set(since) | {"fact_forecast.csv", "fact_model_backtest.csv"}

    def keep(file_name: str, record: dict[str, str]) -> bool:
        if file_name not in big_tables:
            return True
        if levels.get(record["commodity_code"], 99) > LITE_MAX_LEVEL:
            return False
        if file_name in since:
            column, start = since[file_name]
            return record[column] >= start
        return True

    return keep


def _write_excel(files: dict[str, Any], excel_file: str = EXCEL_FILE, keep_row: Any = None) -> dict[str, Any]:
    """รวม CSV ทุกไฟล์เป็น Excel ไฟล์เดียว (หนึ่ง sheet ต่อหนึ่งตาราง).

    keep_row(ชื่อไฟล์, แถวเป็น dict) ใช้กรองแถวสำหรับไฟล์ฉบับย่อ ถ้าไม่ส่งมาจะเก็บทุกแถว

    ใช้ xlsxwriter แบบ constant_memory ซึ่งเขียนทีละแถวลงดิสก์ ไม่เก็บทั้งไฟล์ไว้ใน RAM
    (โหมดนี้ต้องเขียนเรียงแถว จึงไม่ใช้ pandas.to_excel ที่เขียนทีละคอลัมน์)
    """
    import xlsxwriter

    target = EXPORT_DIR / excel_file
    temporary = EXPORT_DIR / f".{excel_file}.tmp"
    sheets = {}
    workbook = xlsxwriter.Workbook(str(temporary), {"constant_memory": True})
    date_format = workbook.add_format({"num_format": "yyyy-mm-dd"})
    try:
        for file_name, info in files.items():
            sheet_name = file_name.removesuffix(".csv")[:31]  # ชื่อ sheet ยาวได้ไม่เกิน 31 ตัวอักษร
            if keep_row is None and info["rows"] > EXCEL_MAX_ROWS:
                print(f"WARN {file_name} has {info['rows']:,} rows; too many for one Excel sheet")
                continue
            worksheet = workbook.add_worksheet(sheet_name)
            with (EXPORT_DIR / file_name).open(encoding="utf-8-sig", newline="") as handle:
                reader = csv.reader(handle)
                header = next(reader)
                worksheet.write_row(0, 0, header)
                row_number = 0
                for row in reader:
                    if keep_row is not None and not keep_row(file_name, dict(zip(header, row))):
                        continue
                    row_number += 1
                    if row_number > EXCEL_MAX_ROWS:
                        print(f"WARN {file_name} truncated at {EXCEL_MAX_ROWS:,} rows")
                        break
                    for column_number, (column, text) in enumerate(zip(header, row)):
                        value = _excel_value(column, text)
                        if value is None:
                            continue
                        if isinstance(value, datetime):
                            worksheet.write_datetime(row_number, column_number, value, date_format)
                        else:
                            worksheet.write(row_number, column_number, value)
            sheets[sheet_name] = row_number
    finally:
        workbook.close()
    os.replace(temporary, target)
    print(f"Wrote {target.name} with sheets {sheets}")
    return {"file": excel_file, "bytes": target.stat().st_size, "sheets": sheets}
