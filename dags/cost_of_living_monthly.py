"""DAG ที่ 2: อัปเดตข้อมูลค่าครองชีพทุกเดือน แล้วเทรนโมเดลและ Export ใหม่.

สนค. ประกาศเงินเฟ้อของเดือนก่อนหน้าช่วงต้นเดือน DAG นี้จึงรันวันที่ 10 ของทุกเดือน
และดึงย้อนหลัง 4 เดือนล่าสุด เผื่อต้นทางแก้ตัวเลขย้อนหลัง (upsert จึงไม่เกิดแถวซ้ำ)

ต้องรัน thai_cost_of_living_backfill ให้เสร็จหนึ่งครั้งก่อน ไม่เช่นนั้น
Data Quality จะไม่ผ่านเพราะข้อมูลยังไม่ถึงหลักล้านแถว
"""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.utils.task_group import TaskGroup

from col_00_settings import DEFAULT_ARGS, MOC_WEB_PRODUCT_GROUPS
from col_03_extract import (
    extract_cpi,
    extract_farm_prices,
    extract_minimum_wage,
    extract_retail_prices,
)
from col_09_pipeline import build_downstream, build_setup_tasks
from col_10_scrape import scrape_retail_prices
from col_11_fuel import extract_fuel_prices

with DAG(
    dag_id="thai_cost_of_living_monthly",
    default_args=DEFAULT_ARGS,
    description="Monthly incremental CPI + prices -> retrain -> forecast -> Power BI export",
    schedule="0 3 10 * *",  # วันที่ 10 เวลา 03:00 UTC (10:00 น. เวลาไทย) ของทุกเดือน
    start_date=datetime(2026, 1, 1),
    catchup=False,  # ไม่ย้อนรันทุกเดือนตั้งแต่ start_date (ย้อนหลังใช้ DAG backfill แทน)
    max_active_runs=1,  # ไม่ให้สองรอบแก้ตารางหรือไฟล์โมเดลพร้อมกัน
    dagrun_timeout=timedelta(hours=4),
    tags=["project", "cost-of-living", "monthly", "etl", "ml"],
) as dag:
    check_environment, create_tables = build_setup_tasks()

    # Extract ทุกแหล่งไม่มี Dependency ระหว่างกัน จึงรันขนานได้
    with TaskGroup(group_id="extract") as extract_group:
        extract_tasks = [
            PythonOperator(
                task_id="cpi_national_regions",
                python_callable=extract_cpi,
                op_kwargs={"dataset": "cpig", "incremental": True},
            ),
            PythonOperator(
                task_id="cpi_provinces",
                python_callable=extract_cpi,
                op_kwargs={"dataset": "cpip", "incremental": True},
                execution_timeout=timedelta(hours=1),
            ),
            PythonOperator(task_id="farm_prices", python_callable=extract_farm_prices),
            PythonOperator(task_id="minimum_wage", python_callable=extract_minimum_wage),
        ]
        retail_api = PythonOperator(
            task_id="retail_prices",
            python_callable=extract_retail_prices,
            op_kwargs={"incremental": True},
        )
        # Web scraping: ยิงเฉพาะช่วงล่าสุด ช่วงเก่าใช้ cache จึงเร็วกว่ารอบ backfill มาก
        scrape_tasks = [
            PythonOperator(
                task_id=f"scrape_prices_{group}",
                python_callable=scrape_retail_prices,
                op_kwargs={"group": group},
                execution_timeout=timedelta(hours=1),
            )
            for group in MOC_WEB_PRODUCT_GROUPS
        ]
        retail_api >> scrape_tasks
        extract_tasks += [
            retail_api,
            *scrape_tasks,
            # ราคาน้ำมันรถจริงจาก Web Service ของ ปตท. (SOAP)
            PythonOperator(task_id="fuel_prices", python_callable=extract_fuel_prices, execution_timeout=timedelta(hours=1)),
        ]

    create_tables >> extract_group
    build_downstream(extract_tasks)
