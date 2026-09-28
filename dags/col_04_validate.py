"""ขั้นที่ 04: ตรวจคุณภาพข้อมูลจาก XCom + ฐานข้อมูล แล้วเลือกเส้นทางด้วย Branching."""

from datetime import date
from typing import Any

from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import (
    INDEX_MAX,
    INDEX_MIN,
    MAX_OUT_OF_RANGE_SHARE,
    MIN_PROVINCES,
    MIN_TOTAL_CPI_ROWS,
    POSTGRES_CONN_ID,
)
from col_01_utils import shift_month

# แหล่งหลักต้องสำเร็จเสมอ ส่วนแหล่งอื่นถ้าล่มจะเป็นแค่คำเตือน
CORE_SOURCES = {"tpso_cpig", "tpso_cpip"}


def validate_extracted_data(extract_task_ids: list[str], **context: Any) -> str:
    """คืนชื่อ Task ถัดไปให้ BranchPythonOperator เลือกเพียงหนึ่งเส้นทาง."""
    task_instance = context["ti"]
    # Airflow 2.10 คืนค่าหลาย task เป็น lazy sequence จึงแปลงเป็น list ก่อนใช้
    metadata = list(task_instance.xcom_pull(task_ids=extract_task_ids) or [])
    problems: list[str] = []
    warnings: list[str] = []

    # 1) ตรวจ metadata ที่ Task Extract ส่งมาทาง XCom
    if len(metadata) != len(extract_task_ids):
        problems.append("incomplete extraction metadata")
    metadata = [item for item in metadata if isinstance(item, dict)]
    core_seen = set()
    for item in metadata:
        source = item.get("source", "unknown")
        if source in CORE_SOURCES:
            core_seen.add(source)
            if item.get("status") != "ok":
                problems.append(f"{source} status={item.get('status')}")
        elif item.get("status") not in ("ok", "partial"):
            warnings.append(f"{source} is {item.get('status')}; related analysis will be skipped")
    missing_core = CORE_SOURCES - core_seen
    if missing_core:
        problems.append(f"missing core sources: {sorted(missing_core)}")

    # 2) ตรวจซ้ำจากฐานข้อมูลจริง ไม่เชื่อเฉพาะตัวเลขใน XCom
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    total_rows, province_count, latest_period, out_of_range = hook.get_first(
        """
        SELECT
            COUNT(*),
            COUNT(DISTINCT area_code) FILTER (WHERE area_type = 'province'),
            MAX(period_date),
            COUNT(*) FILTER (WHERE index_value NOT BETWEEN %s AND %s)
        FROM cpi_monthly;
        """,
        parameters=(INDEX_MIN, INDEX_MAX),
    )
    if total_rows < MIN_TOTAL_CPI_ROWS:
        problems.append(f"cpi_monthly has {total_rows:,} rows (< {MIN_TOTAL_CPI_ROWS:,})")
    if province_count < MIN_PROVINCES:
        problems.append(f"only {province_count} provinces loaded (< {MIN_PROVINCES})")
    # ค่าผิดปกติเล็กน้อยมาจากต้นทาง: เตือนและตัดออกตอน Transform/ML แต่ถ้ามากผิดปกติให้หยุด
    if out_of_range and out_of_range / max(total_rows, 1) > MAX_OUT_OF_RANGE_SHARE:
        problems.append(f"{out_of_range} index values outside {INDEX_MIN}-{INDEX_MAX}")
    elif out_of_range:
        warnings.append(
            f"{out_of_range} index values outside {INDEX_MIN}-{INDEX_MAX} "
            "are kept in cpi_monthly but excluded from summaries and ML"
        )

    # ข้อมูลของ สนค. ช้ากว่าปัจจุบันประมาณ 1 เดือน ถ้าเก่ากว่า 6 เดือนแปลว่ามีปัญหา
    today = date.today()
    stale_year, stale_month = shift_month(today.year, today.month, -6)
    if latest_period is None or latest_period < date(stale_year, stale_month, 1):
        problems.append(f"latest CPI period {latest_period} is stale")

    # ทุกพื้นที่ในเดือนล่าสุดต้องมีดัชนี "รวมทุกรายการ" (00000)
    missing_headline = hook.get_first(
        """
        SELECT COUNT(*) FROM dim_area a
        WHERE NOT EXISTS (
            SELECT 1 FROM cpi_monthly c
            WHERE c.area_type = a.area_type AND c.area_code = a.area_code
              AND c.commodity_code = '00000' AND c.period_date = %s
        );
        """,
        parameters=(latest_period,),
    )[0]
    if missing_headline:
        warnings.append(f"{missing_headline} areas lack headline CPI for {latest_period}")

    report = {
        "total_cpi_rows": int(total_rows),
        "province_count": int(province_count),
        "latest_period": latest_period.isoformat() if latest_period else None,
        "problems": problems,
        "warnings": warnings,
    }
    # ส่งรายงานให้ Task ถัดไปอ่าน (ทั้ง alert และ transform)
    task_instance.xcom_push(key="data_quality_report", value=report)
    print(f"Data quality report: {report}")

    if problems:
        return "data_quality_alert"
    # เส้นทางที่ไม่ได้เลือกจะถูก Airflow mark เป็น skipped
    return "transform_and_load"


def data_quality_alert(**context: Any) -> None:
    """อ่านสาเหตุจาก XCom แล้วบันทึกลง Airflow log ให้ตรวจสอบได้."""
    report = context["ti"].xcom_pull(
        task_ids="validate_extracted_data", key="data_quality_report"
    )
    print("ALERT: pipeline stopped before transform/ML because data quality failed.")
    for problem in (report or {}).get("problems", []):
        print(f" - {problem}")
