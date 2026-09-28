"""ขั้นที่ 09: ประกอบ Task ส่วนท้ายที่ DAG backfill และ DAG รายเดือนใช้ร่วมกัน.

ทั้งสอง DAG ต่างกันแค่วิธี Extract (ย้อนหลังทั้งหมด หรือ เฉพาะเดือนล่าสุด)
ส่วน Validate -> Transform -> ML -> Export เหมือนกัน จึงเขียนไว้ที่เดียว
ฟังก์ชันนี้ต้องถูกเรียกภายใน `with DAG(...)` เพื่อให้ Task ผูกกับ DAG นั้น
"""

from datetime import timedelta

from airflow.models.baseoperator import BaseOperator
from airflow.operators.bash import BashOperator
from airflow.operators.empty import EmptyOperator
from airflow.operators.python import BranchPythonOperator, PythonOperator
from airflow.providers.postgres.operators.postgres import PostgresOperator

from col_00_settings import DATA_DIR, EXPORT_DIR, MODEL_DIR, POSTGRES_CONN_ID
from col_02_database import CREATE_TABLES_SQL
from col_04_validate import data_quality_alert, validate_extracted_data
from col_05_transform import transform_and_load
from col_06_model import (
    decide_deployment,
    deploy_model,
    evaluate_champion,
    evaluate_model,
    generate_forecasts,
    log_model_result,
    skip_deployment,
    smoke_test,
    train_model,
)
from col_07_export import export_powerbi

# หลัง Branch จะมีเส้นหนึ่งถูก skip จึงรอเพียงเส้นที่สำเร็จอย่างน้อยหนึ่ง
JOIN_RULE = "none_failed_min_one_success"


def build_setup_tasks() -> tuple[BaseOperator, BaseOperator]:
    """ตรวจ environment ด้วย BashOperator แล้วสร้างตารางด้วย PostgresOperator."""
    # Workshop 01: BashOperator — สร้างโฟลเดอร์, ตรวจสิทธิ์เขียน และพื้นที่ดิสก์เหลือ >= 2 GB
    check_environment = BashOperator(
        task_id="check_environment",
        bash_command=(
            "set -euo pipefail; "
            f"mkdir -p {DATA_DIR}/raw {DATA_DIR}/seed {EXPORT_DIR} {MODEL_DIR}/candidates; "
            f"test -w {DATA_DIR} && test -w {EXPORT_DIR} && test -w {MODEL_DIR}; "
            f"free_kb=$(df -Pk {DATA_DIR} | awk 'NR==2 {{print $4}}'); "
            'echo "free disk: $((free_kb / 1024)) MB"; '
            'test "$free_kb" -gt 2097152; '
            "python --version"
        ),
    )
    # Workshop 05: PostgresOperator สร้างตารางก่อน Task อื่นเข้าถึงฐานข้อมูล
    create_tables = PostgresOperator(
        task_id="create_tables",
        postgres_conn_id=POSTGRES_CONN_ID,
        sql=CREATE_TABLES_SQL,
    )
    check_environment >> create_tables
    return check_environment, create_tables


def build_downstream(extract_tasks: list[BaseOperator]) -> None:
    """สร้าง Validate -> Transform -> ML -> Forecast -> Export และผูก Dependency."""
    # Workshop 02-03: อ่าน metadata จาก XCom แล้วเลือก transform หรือ alert
    validate = BranchPythonOperator(
        task_id="validate_extracted_data",
        python_callable=validate_extracted_data,
        op_kwargs={"extract_task_ids": [task.task_id for task in extract_tasks]},
    )
    alert = PythonOperator(task_id="data_quality_alert", python_callable=data_quality_alert)
    transform = PythonOperator(
        task_id="transform_and_load",
        python_callable=transform_and_load,
        execution_timeout=timedelta(hours=1),
    )

    # Workshop ML: Train -> Evaluate -> เทียบ Champion -> Deploy หรือ Skip
    train = PythonOperator(
        task_id="train_model",
        python_callable=train_model,
        execution_timeout=timedelta(hours=1),
    )
    evaluate = PythonOperator(task_id="evaluate_model", python_callable=evaluate_model)
    champion = PythonOperator(task_id="evaluate_champion", python_callable=evaluate_champion)
    decide = BranchPythonOperator(task_id="decide_deployment", python_callable=decide_deployment)
    deploy = PythonOperator(task_id="deploy_model", python_callable=deploy_model)
    skip = PythonOperator(task_id="skip_deployment", python_callable=skip_deployment)
    smoke = PythonOperator(task_id="smoke_test", python_callable=smoke_test)
    log_result = PythonOperator(
        task_id="log_model_result",
        python_callable=log_model_result,
        trigger_rule=JOIN_RULE,
    )
    # ทำนายเดือนหน้าด้วย Champion เสมอ ไม่ว่ารอบนี้จะ deploy หรือไม่
    forecast = PythonOperator(task_id="generate_forecasts", python_callable=generate_forecasts)
    export = PythonOperator(task_id="export_powerbi", python_callable=export_powerbi)
    finish = EmptyOperator(task_id="finish", trigger_rule=JOIN_RULE)

    # Dependency ชุดที่ 1: Extract ทุกตัวต้องเสร็จก่อน Validate
    extract_tasks >> validate
    # Dependency ชุดที่ 2: Validate เลือกเพียง alert หรือ transform
    validate >> [alert, transform]
    # Dependency ชุดที่ 3: เส้นทาง ML หลังข้อมูลผ่านการตรวจ
    transform >> train >> evaluate >> champion >> decide
    # Dependency ชุดที่ 4: Candidate ดีกว่าเดิมจึง deploy และ smoke test
    decide >> deploy >> smoke >> log_result
    decide >> skip >> log_result
    # Dependency ชุดที่ 5: พยากรณ์ -> สร้าง CSV ให้ Power BI -> จบ
    log_result >> forecast >> export
    [alert, export] >> finish
