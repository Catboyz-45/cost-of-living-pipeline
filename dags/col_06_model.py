"""ขั้นที่ 06: Train, Evaluate, Champion/Challenger, Deploy, Smoke Test และ Forecast.

โมเดลทำนาย "% เปลี่ยนแปลงของดัชนีราคาเดือนหน้า" ของทุกพื้นที่ × ทุกหมวดสินค้า
ใช้ HistGradientBoostingRegressor เพราะเทรนข้อมูลหลายล้านแถวได้เร็วและใช้ RAM น้อย
"""

import io
import math
import os
import shutil
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pandas as pd
from airflow.providers.postgres.hooks.postgres import PostgresHook

from col_00_settings import (
    CURRENT_MODEL_PATH,
    INDEX_MAX,
    INDEX_MIN,
    ML_HOLDOUT_MONTHS,
    ML_MAX_LEVEL,
    ML_START_YEAR_BE,
    ML_TARGET_CLIP,
    MODEL_DIR,
    MODEL_NAME,
    POSTGRES_CONN_ID,
)
from col_01_utils import be_to_ce, shift_month
from col_02_database import bulk_upsert
from col_08_features import (
    CATEGORICAL_FEATURES,
    FEATURE_COLUMNS,
    build_features,
    complete_rows,
)

CANDIDATE_DIR = MODEL_DIR / "candidates"


def _load_cpi_frame(since: date) -> pd.DataFrame:
    """อ่านดัชนีจาก PostgreSQL ด้วย COPY TO STDOUT ซึ่งเร็วกว่า fetch ทีละแถวมาก."""
    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    connection = hook.get_conn()
    buffer = io.StringIO()
    try:
        with connection.cursor() as cursor:
            # ค่า since และ level มาจาก config ของเรา แต่ยังใช้ mogrify เพื่อ escape ให้ถูกต้อง
            query = cursor.mogrify(
                """
                SELECT c.area_type, c.area_code, c.commodity_code, d.level,
                       c.period_date, c.index_value
                FROM cpi_monthly c
                JOIN dim_commodity d USING (commodity_code)
                WHERE c.period_date >= %s AND d.level <= %s
                  AND c.index_value BETWEEN %s AND %s
                """,
                (since, ML_MAX_LEVEL, INDEX_MIN, INDEX_MAX),
            ).decode()
            cursor.copy_expert(f"COPY ({query}) TO STDOUT WITH CSV HEADER", buffer)
    finally:
        connection.close()
    buffer.seek(0)
    return pd.read_csv(
        buffer,
        dtype={"area_type": str, "area_code": str, "commodity_code": str, "level": "int16"},
        parse_dates=["period_date"],
    )


def _safe_run_id(run_id: str) -> str:
    """เปลี่ยนอักขระพิเศษใน run_id ให้ใช้เป็นชื่อไฟล์ได้อย่างปลอดภัย."""
    return "".join(character if character.isalnum() or character in "-_" else "_" for character in run_id)


def _to_matrix(frame: pd.DataFrame):
    """ดึง Feature ตามลำดับที่กำหนดเป็น numpy array float32."""
    return frame[FEATURE_COLUMNS].to_numpy(dtype="float32")


def train_model(**context: Any) -> dict[str, Any]:
    """เทรน Candidate โดยแบ่ง Holdout ตามเวลา (12 เดือนล่าสุด) ป้องกันข้อมูลอนาคตรั่ว."""
    import joblib
    from sklearn.ensemble import HistGradientBoostingRegressor

    frame = _load_cpi_frame(date(be_to_ce(ML_START_YEAR_BE), 1, 1))
    features, categories = build_features(frame)
    del frame  # คืนหน่วยความจำทันทีเมื่อไม่ใช้แล้ว

    usable = features[complete_rows(features) & features["target"].notna()]
    # ตัด outlier เช่น เดือนที่ราคาถูกปรับโครงสร้างจนกระโดดผิดปกติ
    usable = usable[usable["target"].abs() <= ML_TARGET_CLIP]
    periods = sorted(usable["period_date"].unique())
    if len(periods) <= ML_HOLDOUT_MONTHS + 24:
        raise ValueError(f"Need more history; only {len(periods)} usable months")

    holdout_start = periods[-ML_HOLDOUT_MONTHS]
    train = usable[usable["period_date"] < holdout_start]
    holdout = usable[usable["period_date"] >= holdout_start]

    categorical_mask = [column in CATEGORICAL_FEATURES for column in FEATURE_COLUMNS]
    model = HistGradientBoostingRegressor(
        learning_rate=0.1,
        max_iter=250,
        max_leaf_nodes=63,
        min_samples_leaf=200,  # ใบต้องมีข้อมูลพอ ลด overfit กับ series เล็ก ๆ
        l2_regularization=1.0,
        categorical_features=categorical_mask,
        early_stopping=False,
        random_state=42,
    )
    model.fit(_to_matrix(train), train["target"].to_numpy(dtype="float32"))

    CANDIDATE_DIR.mkdir(parents=True, exist_ok=True)
    safe_run_id = _safe_run_id(context["run_id"])
    candidate_path = CANDIDATE_DIR / f"candidate_{safe_run_id}.pkl"
    holdout_path = CANDIDATE_DIR / f"holdout_{safe_run_id}.pkl"
    trained_through = pd.Timestamp(train["period_date"].max()).date().isoformat()
    # เก็บ categories และลำดับ Feature ไว้กับโมเดล เพื่อให้ API แปลงข้อมูลได้ตรงกัน
    artifact = {
        "model": model,
        "model_name": MODEL_NAME,
        "feature_columns": FEATURE_COLUMNS,
        "categories": categories,
        "trained_through": trained_through,
        "training_rows": int(len(train)),
        "created_at": datetime.now().isoformat(),
    }
    joblib.dump(artifact, candidate_path)
    # Holdout มีเป็นแสนแถว ใหญ่เกินจะส่งผ่าน XCom จึงเขียนเป็นไฟล์แล้วส่งแค่ path
    holdout_columns = ["area_type", "area_code", "commodity_code", *FEATURE_COLUMNS, "target"]
    holdout[holdout_columns].to_pickle(holdout_path)

    result = {
        "candidate_model_path": str(candidate_path),
        "holdout_path": str(holdout_path),
        "training_rows": int(len(train)),
        "holdout_rows": int(len(holdout)),
        "holdout_start": pd.Timestamp(holdout_start).date().isoformat(),
        "trained_through": trained_through,
    }
    print(f"Trained candidate: {result}")
    return result


def _score(model, holdout: pd.DataFrame) -> dict[str, float]:
    """คำนวณ RMSE, MAE, R² และความแม่นทิศทางขึ้น/ลง."""
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

    actual = holdout["target"].to_numpy()
    predicted = model.predict(_to_matrix(holdout))
    # นับเฉพาะเดือนที่ราคาเปลี่ยนจริง (มากกว่า 0.05%) เพราะเดือนที่นิ่งไม่มีทิศทางให้ทาย
    moved = abs(actual) >= 0.05
    direction = (
        float(((predicted[moved] > 0) == (actual[moved] > 0)).mean()) if moved.any() else 0.0
    )
    return {
        "rmse": float(math.sqrt(mean_squared_error(actual, predicted))),
        "mae": float(mean_absolute_error(actual, predicted)),
        "r2": float(r2_score(actual, predicted)),
        "direction_accuracy": direction,
    }


def evaluate_model(**context: Any) -> dict[str, float]:
    """วัดผล Candidate กับเดือนที่ไม่เคยเห็น และเทียบกับ Baseline แบบ "เดือนหน้าเท่าเดิม"."""
    import joblib

    training = context["ti"].xcom_pull(task_ids="train_model")
    artifact = joblib.load(training["candidate_model_path"])
    holdout = pd.read_pickle(training["holdout_path"])
    metrics = _score(artifact["model"], holdout)
    # Baseline ทายว่าราคาเดือนหน้าไม่เปลี่ยน (0%) โมเดลที่ดีต้องชนะค่านี้
    metrics["baseline_rmse"] = float(math.sqrt((holdout["target"].astype("float64") ** 2).mean()))
    print(f"Candidate metrics: {metrics}")
    return metrics


def evaluate_champion(**context: Any) -> float | None:
    """วัด Champion ปัจจุบันบน Holdout ชุดเดียวกับ Candidate เพื่อเทียบกันอย่างยุติธรรม."""
    import joblib

    if not CURRENT_MODEL_PATH.is_file():
        print("No champion yet; the first candidate will be deployed")
        return None
    champion = joblib.load(CURRENT_MODEL_PATH)
    if champion.get("feature_columns") != FEATURE_COLUMNS:
        print("Champion uses an older feature schema; treat as replaceable")
        return None

    training = context["ti"].xcom_pull(task_ids="train_model")
    holdout = pd.read_pickle(training["holdout_path"])
    # แปลง categorical ตาม mapping ของ Champion เอง (อาจต่างจาก Candidate)
    area_key = holdout["area_type"] + ":" + holdout["area_code"]
    holdout["commodity_cat"] = holdout["commodity_code"].map(champion["categories"]["commodity"]).astype("float32")
    holdout["area_cat"] = area_key.map(champion["categories"]["area"]).astype("float32")
    champion_rmse = _score(champion["model"], holdout)["rmse"]
    print(f"Champion RMSE on the same holdout: {champion_rmse:.4f}")
    return champion_rmse


def decide_deployment(**context: Any) -> str:
    """คืนชื่อ Task deploy/skip ให้ BranchPythonOperator เลือกเส้นทาง."""
    metrics = context["ti"].xcom_pull(task_ids="evaluate_model")
    champion_rmse = context["ti"].xcom_pull(task_ids="evaluate_champion")
    # ต้องชนะ Baseline ก่อน ไม่เช่นนั้นโมเดลไม่มีประโยชน์กว่าการทายว่า "ราคาเท่าเดิม"
    if metrics["rmse"] >= metrics["baseline_rmse"]:
        print("Candidate does not beat the naive baseline")
        return "skip_deployment"
    if champion_rmse is None or metrics["rmse"] < champion_rmse:
        print("Candidate is the first model or improves the champion")
        return "deploy_model"
    print("Candidate did not improve the champion")
    return "skip_deployment"


def deploy_model(**context: Any) -> str:
    """เลื่อน Candidate ให้เป็น current_model แบบ atomic."""
    training = context["ti"].xcom_pull(task_ids="train_model")
    candidate_path = Path(training["candidate_model_path"])
    # จำกัด path ให้อยู่ในโฟลเดอร์ candidate ป้องกันการอ่านไฟล์นอกขอบเขต
    if candidate_path.parent != CANDIDATE_DIR or not candidate_path.is_file():
        raise ValueError("Candidate model path is invalid")
    temporary_path = MODEL_DIR / "current_model.tmp"
    shutil.copyfile(candidate_path, temporary_path)
    os.replace(temporary_path, CURRENT_MODEL_PATH)
    print(f"Deployed {candidate_path.name} to {CURRENT_MODEL_PATH}")
    return "deployed"


def skip_deployment(**context: Any) -> str:
    """คง Champion เดิมไว้เมื่อ Candidate ไม่ได้ดีกว่า."""
    metrics = context["ti"].xcom_pull(task_ids="evaluate_model")
    champion_rmse = context["ti"].xcom_pull(task_ids="evaluate_champion")
    print(f"Kept champion (RMSE {champion_rmse}); candidate RMSE {metrics['rmse']:.4f}")
    return "skipped"


def smoke_test(**context: Any) -> dict[str, Any]:
    """โหลดโมเดลที่ deploy จริงแล้วลองทำนาย ต้องได้ตัวเลขที่ใช้ได้ทุกแถว."""
    import joblib

    artifact = joblib.load(CURRENT_MODEL_PATH)
    if artifact.get("feature_columns") != FEATURE_COLUMNS:
        raise ValueError("Deployed model feature schema is incompatible")
    training = context["ti"].xcom_pull(task_ids="train_model")
    sample = pd.read_pickle(training["holdout_path"]).head(1000)
    predictions = artifact["model"].predict(_to_matrix(sample))
    if not all(math.isfinite(float(value)) for value in predictions):
        raise ValueError("Model returned a non-finite prediction")
    result = {"rows_tested": int(len(sample)), "mean_prediction_pct": round(float(predictions.mean()), 4)}
    print(f"Smoke test passed: {result}")
    return result


def log_model_result(**context: Any) -> None:
    """บันทึก Metric และสถานะ deploy ของรอบนี้."""
    task_instance = context["ti"]
    metrics = task_instance.xcom_pull(task_ids="evaluate_model")
    training = task_instance.xcom_pull(task_ids="train_model")
    # ถ้า branch deploy ถูก skip ค่า XCom จะเป็น None และ deployed จะเป็น False
    deployed = task_instance.xcom_pull(task_ids="deploy_model") == "deployed"
    PostgresHook(postgres_conn_id=POSTGRES_CONN_ID).run(
        """
        INSERT INTO cpi_model_metrics (
            model_name, rmse, mae, r2, baseline_rmse, direction_accuracy,
            training_rows, holdout_rows, deployed, run_id
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
        """,
        parameters=(
            MODEL_NAME, metrics["rmse"], metrics["mae"], metrics["r2"],
            metrics["baseline_rmse"], metrics["direction_accuracy"],
            training["training_rows"], training["holdout_rows"], deployed, context["run_id"],
        ),
    )
    # ลบไฟล์ holdout ของรอบนี้ ไม่ให้เต็มดิสก์ (ไฟล์ candidate เก็บไว้ย้อนดูได้)
    Path(training["holdout_path"]).unlink(missing_ok=True)
    print(f"Logged model result; deployed={deployed}")


def generate_forecasts(**_: Any) -> dict[str, Any]:
    """ใช้ Champion ทำนายเดือนถัดไปของทุก series แล้วบันทึกลง cpi_forecasts."""
    import joblib

    if not CURRENT_MODEL_PATH.is_file():
        raise FileNotFoundError("No deployed model; run the pipeline until deploy_model succeeds")
    artifact = joblib.load(CURRENT_MODEL_PATH)

    hook = PostgresHook(postgres_conn_id=POSTGRES_CONN_ID)
    latest = hook.get_first("SELECT MAX(period_date) FROM cpi_monthly;")[0]
    # ต้องมีย้อนหลัง 12 เดือนสำหรับ lag จึงโหลด 14 เดือนล่าสุด
    start_year, start_month = shift_month(latest.year, latest.month, -13)
    frame = _load_cpi_frame(date(start_year, start_month, 1))
    features, _ = build_features(frame, artifact["categories"])
    current = features[(features["period_date"] == pd.Timestamp(latest)) & complete_rows(features)]
    if current.empty:
        raise ValueError(f"No complete feature rows for {latest}")

    predicted = artifact["model"].predict(_to_matrix(current))
    target_year, target_month = shift_month(latest.year, latest.month, 1)
    target_period = date(target_year, target_month, 1)
    rows = [
        (
            row.area_type, row.area_code, row.commodity_code, latest, target_period,
            float(row.index_value), float(change), float(row.index_value) * (1 + float(change) / 100),
            artifact["model_name"],
        )
        for row, change in zip(current.itertuples(index=False), predicted)
    ]
    bulk_upsert(
        "cpi_forecasts",
        ["area_type", "area_code", "commodity_code", "base_period", "target_period",
         "base_index", "predicted_change_pct", "predicted_index", "model_name"],
        ["area_type", "area_code", "commodity_code", "target_period"],
        rows,
    )
    result = {
        "base_period": latest.isoformat(),
        "target_period": target_period.isoformat(),
        "series_forecasted": len(rows),
    }
    print(f"Forecasts saved: {result}")
    return result
