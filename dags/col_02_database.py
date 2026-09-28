"""ขั้นที่ 02: โครงสร้างตาราง PostgreSQL และฟังก์ชันโหลดข้อมูลจำนวนมาก."""

import csv
import io
from typing import Any, Iterable, Sequence

from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import POSTGRES_CONN_ID

# PostgresOperator ใน DAG จะรัน SQL ชุดนี้ก่อน Task อื่นเข้าถึงฐานข้อมูล
# แบ่งเป็น 3 ชั้น: dimension (ข้อมูลอ้างอิง), fact ดิบ (silver), ตารางวิเคราะห์ (gold)
CREATE_TABLES_SQL = """
-- ===================== Dimension =====================
-- พื้นที่: ประเทศ/ภาค (region) และจังหวัด (province)
CREATE TABLE IF NOT EXISTS dim_area (
    area_type VARCHAR(10) NOT NULL CHECK (area_type IN ('region', 'province')),
    area_code VARCHAR(4) NOT NULL,
    area_name VARCHAR(120) NOT NULL,
    region_code VARCHAR(4) NOT NULL,
    PRIMARY KEY (area_type, area_code)
);

-- หมวดสินค้าในดัชนีราคาผู้บริโภค (ระดับ 1 = รวม, 2 = หมวดใหญ่, 3 = หมวดย่อย)
CREATE TABLE IF NOT EXISTS dim_commodity (
    commodity_code VARCHAR(10) PRIMARY KEY,
    commodity_name VARCHAR(200) NOT NULL,
    level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 9)
);

-- สินค้าขายปลีกของกรมการค้าภายใน และหมวดดัชนีที่สินค้านั้นเป็นตัวแทน
CREATE TABLE IF NOT EXISTS dim_product (
    product_id VARCHAR(20) PRIMARY KEY,
    product_name VARCHAR(200) NOT NULL,
    label VARCHAR(200) NOT NULL,
    unit VARCHAR(60),
    cpi_code VARCHAR(10) NOT NULL
);
-- คอลัมน์ที่เพิ่มตอนมี web scraping (ADD IF NOT EXISTS จึงรันซ้ำได้)
-- ขยาย label เฉพาะตอนที่ยังสั้นอยู่ (ALTER TYPE ต้องล็อกตาราง จึงไม่ทำซ้ำทุกรอบ)
DO $$
BEGIN
    IF (SELECT character_maximum_length FROM information_schema.columns
        WHERE table_name = 'dim_product' AND column_name = 'label') < 200 THEN
        ALTER TABLE dim_product ALTER COLUMN label TYPE VARCHAR(200);
    END IF;
END $$;
ALTER TABLE dim_product ADD COLUMN IF NOT EXISTS product_group VARCHAR(120);
ALTER TABLE dim_product ADD COLUMN IF NOT EXISTS source VARCHAR(20);

-- ===================== Silver: ข้อมูลจากต้นทางที่ทำความสะอาดแล้ว =====================
-- ตารางหลักหลักล้านแถว: ดัชนีราคารายเดือน × พื้นที่ × หมวดสินค้า
CREATE TABLE IF NOT EXISTS cpi_monthly (
    area_type VARCHAR(10) NOT NULL,
    area_code VARCHAR(4) NOT NULL,
    commodity_code VARCHAR(10) NOT NULL,
    period_date DATE NOT NULL,
    index_value DOUBLE PRECISION NOT NULL CHECK (index_value > 0),
    change_mom DOUBLE PRECISION,
    change_yoy DOUBLE PRECISION,
    change_avg DOUBLE PRECISION,
    year_base SMALLINT NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (area_type, area_code, commodity_code, period_date)
);
CREATE INDEX IF NOT EXISTS idx_cpi_monthly_period ON cpi_monthly (period_date);
CREATE INDEX IF NOT EXISTS idx_cpi_monthly_commodity
    ON cpi_monthly (commodity_code, period_date);

-- ราคาขายปลีกรายวันเป็นบาท (ต่ำสุด/สูงสุดของวัน)
CREATE TABLE IF NOT EXISTS retail_prices_daily (
    product_id VARCHAR(20) NOT NULL,
    price_date DATE NOT NULL,
    price_min DOUBLE PRECISION NOT NULL CHECK (price_min >= 0),
    price_max DOUBLE PRECISION NOT NULL CHECK (price_max >= price_min),
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (product_id, price_date)
);

-- ราคาที่เกษตรกรขายได้ (หน้าฟาร์ม) รายเดือน จากกรมปศุสัตว์
CREATE TABLE IF NOT EXISTS farm_prices_monthly (
    item_name VARCHAR(200) NOT NULL,
    period_date DATE NOT NULL,
    price DOUBLE PRECISION NOT NULL CHECK (price >= 0),
    unit VARCHAR(40),
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_name, period_date)
);

-- ค่าจ้างขั้นต่ำรายวันตามประกาศ แต่ละแถวมีผลตั้งแต่ effective_date
CREATE TABLE IF NOT EXISTS minimum_wage (
    province_code VARCHAR(4) NOT NULL,
    province_name VARCHAR(120) NOT NULL,
    effective_date DATE NOT NULL,
    valid_until DATE,
    daily_wage DOUBLE PRECISION NOT NULL CHECK (daily_wage > 0),
    source VARCHAR(300) NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (province_code, effective_date)
);

-- บันทึกจำนวนแถวที่โหลดในแต่ละรอบ ใช้แสดงปริมาณข้อมูลใน dashboard
CREATE TABLE IF NOT EXISTS etl_load_log (
    id BIGSERIAL PRIMARY KEY,
    dag_id VARCHAR(250) NOT NULL,
    run_id VARCHAR(250) NOT NULL,
    source VARCHAR(100) NOT NULL,
    rows_loaded INTEGER NOT NULL CHECK (rows_loaded >= 0),
    note VARCHAR(500),
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== Gold: ตารางที่ Transform แล้วสำหรับวิเคราะห์ =====================
-- ราคาจริงเฉลี่ยรายเดือนของสินค้าแต่ละตัว สรุปจากราคารายวัน (กลางระหว่างราคาต่ำสุด-สูงสุด)
CREATE TABLE IF NOT EXISTS retail_price_monthly (
    product_id VARCHAR(20) NOT NULL,
    period_date DATE NOT NULL,
    avg_price DOUBLE PRECISION NOT NULL,
    low_price DOUBLE PRECISION NOT NULL,
    high_price DOUBLE PRECISION NOT NULL,
    days_observed INTEGER NOT NULL,
    PRIMARY KEY (product_id, period_date)
);

-- ราคาเป็นบาท: ค่าจริงจาก API และค่าประมาณจากดัชนี
CREATE TABLE IF NOT EXISTS price_estimates (
    product_id VARCHAR(20) NOT NULL,
    period_date DATE NOT NULL,
    actual_price DOUBLE PRECISION,
    estimated_price DOUBLE PRECISION NOT NULL,
    anchor_period DATE NOT NULL,
    anchor_price DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (product_id, period_date)
);

-- ค่าแรงที่แท้จริง: ค่าแรงขั้นต่ำหักผลของเงินเฟ้อ (หน่วยเป็นบาทของปีฐาน 2566)
CREATE TABLE IF NOT EXISTS real_wage_monthly (
    province_code VARCHAR(4) NOT NULL,
    period_date DATE NOT NULL,
    nominal_wage DOUBLE PRECISION NOT NULL,
    cpi_all_items DOUBLE PRECISION NOT NULL,
    cpi_food DOUBLE PRECISION,
    real_wage DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (province_code, period_date)
);

-- สรุปรายปี: ค่าดัชนีเฉลี่ยและ % เปลี่ยนแปลงจากปีก่อน
CREATE TABLE IF NOT EXISTS cpi_yearly_summary (
    area_type VARCHAR(10) NOT NULL,
    area_code VARCHAR(4) NOT NULL,
    commodity_code VARCHAR(10) NOT NULL,
    year_ce SMALLINT NOT NULL,
    avg_index DOUBLE PRECISION NOT NULL,
    yoy_pct DOUBLE PRECISION,
    months_covered SMALLINT NOT NULL,
    PRIMARY KEY (area_type, area_code, commodity_code, year_ce)
);

-- ความสัมพันธ์ระหว่างราคาหน้าฟาร์มกับดัชนีราคาขายปลีก (ไม่ใช่เหตุและผล)
CREATE TABLE IF NOT EXISTS farm_retail_correlation (
    id BIGSERIAL PRIMARY KEY,
    farm_item VARCHAR(200) NOT NULL,
    cpi_code VARCHAR(10) NOT NULL,
    lag_months SMALLINT NOT NULL,
    pearson_correlation DOUBLE PRECISION NOT NULL,
    sample_size INTEGER NOT NULL CHECK (sample_size > 2),
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== ML =====================
CREATE TABLE IF NOT EXISTS cpi_model_metrics (
    id BIGSERIAL PRIMARY KEY,
    model_name VARCHAR(100) NOT NULL,
    rmse DOUBLE PRECISION NOT NULL CHECK (rmse >= 0),
    mae DOUBLE PRECISION NOT NULL CHECK (mae >= 0),
    r2 DOUBLE PRECISION NOT NULL,
    baseline_rmse DOUBLE PRECISION NOT NULL CHECK (baseline_rmse >= 0),
    direction_accuracy DOUBLE PRECISION NOT NULL,
    training_rows INTEGER NOT NULL CHECK (training_rows > 0),
    holdout_rows INTEGER NOT NULL CHECK (holdout_rows > 0),
    deployed BOOLEAN NOT NULL,
    run_id VARCHAR(250) NOT NULL,
    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cpi_metrics_champion
    ON cpi_model_metrics (model_name, deployed, run_at DESC);

-- ผลพยากรณ์เดือนถัดไป: หนึ่งแถวต่อพื้นที่ × หมวดสินค้า × เดือนเป้าหมาย
-- ผลทดสอบย้อนหลังของโมเดลที่ใช้งานจริง: ทายเดือนที่โมเดลไม่เคยเห็นตอนเทรน เทียบกับค่าจริง
CREATE TABLE IF NOT EXISTS cpi_backtest (
    area_type VARCHAR(10) NOT NULL,
    area_code VARCHAR(4) NOT NULL,
    commodity_code VARCHAR(10) NOT NULL,
    base_period DATE NOT NULL,
    target_period DATE NOT NULL,
    predicted_change_pct DOUBLE PRECISION NOT NULL,
    actual_change_pct DOUBLE PRECISION NOT NULL,
    model_trained_through DATE NOT NULL,
    PRIMARY KEY (area_type, area_code, commodity_code, target_period)
);

CREATE TABLE IF NOT EXISTS cpi_forecasts (
    area_type VARCHAR(10) NOT NULL,
    area_code VARCHAR(4) NOT NULL,
    commodity_code VARCHAR(10) NOT NULL,
    base_period DATE NOT NULL,
    target_period DATE NOT NULL,
    base_index DOUBLE PRECISION NOT NULL,
    predicted_change_pct DOUBLE PRECISION NOT NULL,
    predicted_index DOUBLE PRECISION NOT NULL,
    model_name VARCHAR(100) NOT NULL,
    predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (area_type, area_code, commodity_code, target_period)
);
"""


def _to_csv_buffer(rows: Iterable[Sequence[Any]]) -> io.StringIO:
    """แปลง tuple เป็นข้อความ CSV ในหน่วยความจำ ให้ COPY อ่านต่อได้."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in rows:
        # None ต้องกลายเป็นช่องว่าง ซึ่ง COPY จะอ่านเป็น NULL
        writer.writerow(["" if value is None else value for value in row])
    buffer.seek(0)
    return buffer


def bulk_upsert(
    table: str,
    columns: Sequence[str],
    key_columns: Sequence[str],
    rows: list[Sequence[Any]],
    chunk_size: int = 200_000,
) -> int:
    """โหลดข้อมูลจำนวนมากด้วย COPY แล้ว upsert เข้าตารางจริงแบบ idempotent.

    INSERT ทีละแถวช้าเกินไปสำหรับข้อมูลหลักล้าน จึงใช้ 3 ขั้น:
    COPY เข้า temp table -> INSERT ... ON CONFLICT DO UPDATE -> ลบ temp table
    ทุกขั้นอยู่ใน transaction เดียว ถ้าพังกลางทางข้อมูลจะไม่ค้างครึ่งเดียว
    """
    if not rows:
        return 0

    # ชื่อตาราง/คอลัมน์มาจากโค้ดของเราเท่านั้น ไม่ได้มาจากผู้ใช้ จึงประกอบ SQL ได้
    column_sql = ", ".join(columns)
    update_columns = [column for column in columns if column not in key_columns]
    update_sql = ", ".join(f"{column} = EXCLUDED.{column}" for column in update_columns)
    conflict_action = f"DO UPDATE SET {update_sql}" if update_sql else "DO NOTHING"

    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    connection = hook.get_conn()
    loaded = 0
    try:
        with connection.cursor() as cursor:
            # temp table หายเองเมื่อ transaction จบ ไม่ชนกับ Task อื่นที่รันขนาน
            cursor.execute(
                f"CREATE TEMP TABLE staging (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DROP;"
            )
            for start in range(0, len(rows), chunk_size):
                chunk = rows[start : start + chunk_size]
                cursor.copy_expert(
                    f"COPY staging ({column_sql}) FROM STDIN WITH (FORMAT csv, NULL '')",
                    _to_csv_buffer(chunk),
                )
                loaded += len(chunk)
            # DISTINCT ON กันกรณีต้นทางส่ง key ซ้ำในชุดเดียวกัน (ON CONFLICT จะ error)
            cursor.execute(
                f"""
                INSERT INTO {table} ({column_sql})
                SELECT DISTINCT ON ({", ".join(key_columns)}) {column_sql}
                FROM staging
                ON CONFLICT ({", ".join(key_columns)}) {conflict_action};
                """
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    return loaded


def log_load(context: dict[str, Any], source: str, rows: int, note: str = "") -> None:
    """บันทึกจำนวนแถวที่โหลดของแต่ละแหล่งข้อมูลลง etl_load_log."""
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    hook.run(
        """
        INSERT INTO etl_load_log (dag_id, run_id, source, rows_loaded, note)
        VALUES (%s, %s, %s, %s, %s);
        """,
        parameters=(context["dag"].dag_id, context["run_id"], source, rows, note[:500]),
    )
