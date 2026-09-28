"""DAG ที่ 1: ดึงข้อมูลค่าครองชีพย้อนหลังทั้งหมด (รันครั้งแรกครั้งเดียว).

ดึงดัชนีราคาผู้บริโภคระดับจังหวัดตั้งแต่ปี 2541 และระดับประเทศ/ภาคตั้งแต่ปี 2519
รวมประมาณ 3-4 ล้านแถว โดยแบ่งช่วงปีเป็นหลาย Task ให้รันขนานกัน
เมื่อ Extract เสร็จจะ Validate, Transform, เทรนโมเดล และ Export ต่อจนจบ

ไฟล์นี้มีหน้าที่สร้าง Task และ Dependency เท่านั้น การทำงานจริงอยู่ในไฟล์ col_00-09
"""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.utils.task_group import TaskGroup

from col_00_settings import DEFAULT_ARGS, MOC_WEB_PRODUCT_GROUPS, PROVINCE_BACKFILL_CHUNKS
from col_03_extract import (
    extract_cpi,
    extract_farm_prices,
    extract_minimum_wage,
    extract_retail_prices,
)
from col_09_pipeline import build_downstream, build_setup_tasks
from col_10_scrape import scrape_retail_prices

with DAG(
    dag_id="thai_cost_of_living_backfill",
    default_args=DEFAULT_ARGS,
    description="Backfill Thai CPI (millions of rows), retail prices, wages -> ML -> Power BI",
    schedule=None,  # สั่งรันเองครั้งเดียวตอนเริ่มโปรเจกต์
    start_date=datetime(2026, 1, 1),
    catchup=False,
    max_active_runs=1,
    max_active_tasks=10,  # จำกัดจำนวน request ที่ยิงไปหาเซิร์ฟเวอร์ภาครัฐพร้อมกัน
    tags=["project", "cost-of-living", "backfill", "etl", "ml"],
) as dag:
    check_environment, create_tables = build_setup_tasks()

    # Workshop 04: สร้าง Task จาก config ด้วย loop และให้รันขนานกัน
    # TaskGroup ช่วยจัดกลุ่มให้หน้า Graph ของ Airflow อ่านง่าย
    with TaskGroup(group_id="extract") as extract_group:
        extract_tasks = [
            PythonOperator(
                task_id="cpi_national_regions",
                python_callable=extract_cpi,
                op_kwargs={"dataset": "cpig"},
                execution_timeout=timedelta(hours=3),
            )
        ]
        for start_year, end_year in PROVINCE_BACKFILL_CHUNKS:
            label = f"{start_year}_{end_year or 'latest'}"
            extract_tasks.append(
                PythonOperator(
                    task_id=f"cpi_provinces_{label}",
                    python_callable=extract_cpi,
                    op_kwargs={
                        "dataset": "cpip",
                        "start_year_be": start_year,
                        "end_year_be": end_year,
                    },
                    execution_timeout=timedelta(hours=3),
                )
            )
        retail_api = PythonOperator(
            task_id="retail_prices",
            python_callable=extract_retail_prices,
            op_kwargs={"incremental": False},
            execution_timeout=timedelta(hours=2),
        )
        # Web scraping ราคาจริงหลายร้อยสินค้า แบ่งตามกลุ่มรหัสให้รันขนานกัน
        # รอ Task API ก่อน เพื่อไม่ให้สอง Task เขียนราคาสินค้าตัวเดียวกันพร้อมกัน
        scrape_tasks = [
            PythonOperator(
                task_id=f"scrape_prices_{group}",
                python_callable=scrape_retail_prices,
                op_kwargs={"group": group},
                execution_timeout=timedelta(hours=2),
            )
            for group in MOC_WEB_PRODUCT_GROUPS
        ]
        retail_api >> scrape_tasks
        extract_tasks += [
            retail_api,
            *scrape_tasks,
            PythonOperator(task_id="farm_prices", python_callable=extract_farm_prices),
            PythonOperator(task_id="minimum_wage", python_callable=extract_minimum_wage),
        ]

    create_tables >> extract_group
    build_downstream(extract_tasks)
