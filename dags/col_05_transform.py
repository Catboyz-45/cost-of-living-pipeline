"""ขั้นที่ 05: สร้างตาราง gold สำหรับวิเคราะห์จากตาราง silver.

งานหนักทำด้วย SQL ใน PostgreSQL เพราะข้อมูลหลักล้านแถว ถ้าดึงทั้งหมดมาเข้า
pandas จะเปลือง RAM ของ Airflow worker มาก ส่วน pandas ใช้เฉพาะชุดเล็ก
"""

from typing import Any

import pandas as pd
from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import (
    ANCHOR_AREA_CODE,
    ANCHOR_AREA_TYPE,
    INDEX_MAX,
    INDEX_MIN,
    MINIMUM_WAGE_CURRENT_AS_OF,
    POSTGRES_CONN_ID,
)

# คู่ราคาหน้าฟาร์มกับหมวดดัชนีราคาขายปลีก (ค้นจากคำในชื่อรายการของกรมปศุสัตว์)
FARM_TO_CPI = [
    ("สุกรมีชีวิต", "11211"),  # หมูหน้าฟาร์ม -> เนื้อสัตว์สด
    ("ไก่เนื้อมีชีวิต", "11221"),  # ไก่หน้าฟาร์ม -> เป็ด ไก่ สด
    ("ไข่ไก่", "11310"),  # ไข่หน้าฟาร์ม -> ไข่
    ("น้ำนม", "11320"),  # น้ำนมดิบ -> นมและผลิตภัณฑ์นม
    ("โคเนื้อ", "11211"),  # วัวหน้าฟาร์ม -> เนื้อสัตว์สด
]

YEARLY_SUMMARY_SQL = """
INSERT INTO cpi_yearly_summary (
    area_type, area_code, commodity_code, year_ce, avg_index, yoy_pct, months_covered
)
WITH yearly AS (
    SELECT area_type, area_code, commodity_code,
           EXTRACT(YEAR FROM period_date)::SMALLINT AS year_ce,
           AVG(index_value) AS avg_index,
           COUNT(*)::SMALLINT AS months_covered
    FROM cpi_monthly
    -- ตัดค่าดัชนีผิดปกติจากต้นทางออก (Validate รายงานจำนวนไว้แล้ว)
    WHERE index_value BETWEEN %(index_min)s AND %(index_max)s
    GROUP BY 1, 2, 3, 4
)
SELECT y.area_type, y.area_code, y.commodity_code, y.year_ce, y.avg_index,
       -- เทียบกับค่าเฉลี่ยปีก่อนหน้า ได้อัตราเงินเฟ้อรายปีของหมวดนั้น
       (y.avg_index / NULLIF(p.avg_index, 0) - 1) * 100 AS yoy_pct,
       y.months_covered
FROM yearly y
LEFT JOIN yearly p
  ON p.area_type = y.area_type AND p.area_code = y.area_code
 AND p.commodity_code = y.commodity_code AND p.year_ce = y.year_ce - 1
ON CONFLICT (area_type, area_code, commodity_code, year_ce) DO UPDATE SET
    avg_index = EXCLUDED.avg_index,
    yoy_pct = EXCLUDED.yoy_pct,
    months_covered = EXCLUDED.months_covered;
"""

# แปลงดัชนีเป็นบาท: ราคา_t = ราคาจริงเดือนอ้างอิง × ดัชนี_t ÷ ดัชนีเดือนอ้างอิง
PRICE_ESTIMATE_SQL = """
DELETE FROM price_estimates;
WITH actual AS (
    -- ราคาจริงรายเดือน = ค่าเฉลี่ยของ (ต่ำสุด+สูงสุด)/2 ทุกวันในเดือน
    SELECT product_id,
           DATE_TRUNC('month', price_date)::DATE AS period_date,
           AVG((price_min + price_max) / 2) AS actual_price
    FROM retail_prices_daily
    GROUP BY 1, 2
),
anchor AS (
    -- เลือกเดือนล่าสุดที่มีทั้งราคาจริงและดัชนี เป็นจุดอ้างอิงของสินค้าแต่ละตัว
    SELECT DISTINCT ON (a.product_id)
           a.product_id, p.cpi_code, a.period_date AS anchor_period,
           a.actual_price AS anchor_price, c.index_value AS anchor_index
    FROM actual a
    JOIN dim_product p USING (product_id)
    JOIN cpi_monthly c
      ON c.area_type = %(area_type)s AND c.area_code = %(area_code)s
     AND c.commodity_code = p.cpi_code AND c.period_date = a.period_date
    ORDER BY a.product_id, a.period_date DESC
)
INSERT INTO price_estimates (
    product_id, period_date, actual_price, estimated_price, anchor_period, anchor_price
)
SELECT an.product_id, c.period_date, act.actual_price,
       an.anchor_price * c.index_value / an.anchor_index,
       an.anchor_period, an.anchor_price
FROM anchor an
JOIN cpi_monthly c
  ON c.area_type = %(area_type)s AND c.area_code = %(area_code)s
 AND c.commodity_code = an.cpi_code
LEFT JOIN actual act
  ON act.product_id = an.product_id AND act.period_date = c.period_date;
"""

# ค่าแรงที่แท้จริง = ค่าแรงขั้นต่ำ ÷ (ดัชนีราคารวม ÷ 100) หน่วยเป็นบาทของปี 2566
REAL_WAGE_SQL = """
DELETE FROM real_wage_monthly;
WITH wage AS (
    SELECT province_code, daily_wage, effective_date,
           COALESCE(
               valid_until,
               LEAD(effective_date) OVER w - 1,
               -- ยังไม่มีประกาศถัดไป: ใช้ได้ถึงวันที่ตรวจแล้วว่าเป็นอัตราปัจจุบัน ไม่เดาเกินนั้น
               %(wage_current_as_of)s::DATE
           ) AS valid_to
    FROM minimum_wage
    WINDOW w AS (PARTITION BY province_code ORDER BY effective_date)
),
months AS (
    SELECT w.province_code, w.daily_wage, gs::DATE AS period_date
    FROM wage w,
         GENERATE_SERIES(
             DATE_TRUNC('month', w.effective_date)::TIMESTAMP,
             w.valid_to::TIMESTAMP,
             INTERVAL '1 month'
         ) gs
),
cpi_area AS (
    -- ดัชนีรายจังหวัดไม่มีกรุงเทพฯ จึงใช้ดัชนี "กรุงเทพฯ และปริมณฑล" แทน
    SELECT m.*,
           CASE WHEN m.province_code = '10' THEN 'region' ELSE 'province' END AS area_type
    FROM months m
)
INSERT INTO real_wage_monthly (
    province_code, period_date, nominal_wage, cpi_all_items, cpi_food, real_wage
)
SELECT m.province_code, m.period_date, m.daily_wage,
       headline.index_value, food.index_value,
       m.daily_wage / (headline.index_value / 100)
FROM cpi_area m
JOIN cpi_monthly headline
  ON headline.area_type = m.area_type AND headline.area_code = m.province_code
 AND headline.commodity_code = '00000' AND headline.period_date = m.period_date
LEFT JOIN cpi_monthly food
  ON food.area_type = m.area_type AND food.area_code = m.province_code
 AND food.commodity_code = '10000' AND food.period_date = m.period_date
ON CONFLICT (province_code, period_date) DO NOTHING;
"""


def _farm_retail_correlations(hook: PostgresHook) -> list[tuple[Any, ...]]:
    """หาความสัมพันธ์ของ % เปลี่ยนแปลงราคาหน้าฟาร์มกับดัชนีขายปลีก ที่ lag 0-3 เดือน."""
    farm = pd.DataFrame(
        hook.get_records("SELECT item_name, period_date, price FROM farm_prices_monthly;"),
        columns=["item_name", "period_date", "price"],
    )
    if farm.empty:
        return []
    cpi_codes = sorted({code for _, code in FARM_TO_CPI})
    retail = pd.DataFrame(
        hook.get_records(
            """
            SELECT commodity_code, period_date, index_value FROM cpi_monthly
            WHERE area_type = 'region' AND area_code = 'TG' AND commodity_code = ANY(%s);
            """,
            parameters=(cpi_codes,),
        ),
        columns=["commodity_code", "period_date", "index_value"],
    )
    rows = []
    for item_name, item_frame in farm.groupby("item_name"):
        cpi_code = next((code for keyword, code in FARM_TO_CPI if keyword in item_name), None)
        if cpi_code is None:
            continue
        farm_change = item_frame.set_index("period_date")["price"].sort_index().pct_change()
        retail_series = (
            retail[retail["commodity_code"] == cpi_code]
            .set_index("period_date")["index_value"].sort_index().pct_change()
        )
        for lag in range(0, 4):
            # lag = ราคาหน้าฟาร์มเปลี่ยนก่อนราคาขายปลีกกี่เดือน
            joined = pd.concat(
                [farm_change.rename("farm"), retail_series.shift(-lag).rename("retail")],
                axis=1,
                join="inner",
            ).dropna()
            if len(joined) > 12:
                correlation = joined["farm"].corr(joined["retail"])
                if pd.notna(correlation):
                    rows.append((item_name, cpi_code, lag, float(correlation), int(len(joined))))
    return rows


# ราคาจริงรายเดือน: เฉลี่ยจากราคากลาง (ต่ำสุด+สูงสุด)/2 ของทุกวันที่มีการสำรวจ
RETAIL_MONTHLY_SQL = """
DELETE FROM retail_price_monthly;
INSERT INTO retail_price_monthly (product_id, period_date, avg_price, low_price, high_price, days_observed)
SELECT product_id, DATE_TRUNC('month', price_date)::DATE,
       AVG((price_min + price_max) / 2), MIN(price_min), MAX(price_max), COUNT(*)
FROM retail_prices_daily
GROUP BY 1, 2;
"""


def transform_and_load(**context: Any) -> dict[str, Any]:
    """รัน Transform ทั้งหมดใน transaction เดียว แล้วคืนสรุปผ่าน XCom."""
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    correlation_rows = _farm_retail_correlations(hook)

    connection = hook.get_conn()
    try:
        with connection.cursor() as cursor:
            # อัปเดตสถิติตารางหลังโหลดข้อมูลหลักล้านแถว ช่วยให้ query ถัดไปเร็วขึ้น
            cursor.execute("ANALYZE cpi_monthly;")
            cursor.execute("ANALYZE retail_prices_daily;")
            cursor.execute(RETAIL_MONTHLY_SQL)
            cursor.execute(YEARLY_SUMMARY_SQL, {"index_min": INDEX_MIN, "index_max": INDEX_MAX})
            cursor.execute(
                PRICE_ESTIMATE_SQL,
                {"area_type": ANCHOR_AREA_TYPE, "area_code": ANCHOR_AREA_CODE},
            )
            cursor.execute(REAL_WAGE_SQL, {"wage_current_as_of": MINIMUM_WAGE_CURRENT_AS_OF})
            cursor.executemany(
                """
                INSERT INTO farm_retail_correlation (
                    farm_item, cpi_code, lag_months, pearson_correlation, sample_size
                ) VALUES (%s, %s, %s, %s, %s);
                """,
                correlation_rows,
            )
            cursor.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM cpi_yearly_summary),
                    (SELECT COUNT(*) FROM price_estimates),
                    (SELECT COUNT(DISTINCT product_id) FROM price_estimates),
                    (SELECT COUNT(*) FROM real_wage_monthly),
                    (SELECT COUNT(*) FROM retail_price_monthly);
                """
            )
            yearly_rows, price_rows, priced_products, real_wage_rows, retail_monthly_rows = cursor.fetchone()
        connection.commit()
    except Exception:
        # ป้องกันตารางสรุปบางตารางสำเร็จแต่บางตารางไม่สำเร็จ
        connection.rollback()
        raise
    finally:
        connection.close()

    result = {
        "yearly_summary_rows": int(yearly_rows),
        "price_estimate_rows": int(price_rows),
        "priced_products": int(priced_products),
        "real_wage_rows": int(real_wage_rows),
        "retail_price_monthly_rows": int(retail_monthly_rows),
        "farm_retail_correlations": len(correlation_rows),
    }
    print(f"Transformed {result}")
    return result
