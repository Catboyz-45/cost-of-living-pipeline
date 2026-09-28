"""FastAPI + หน้าเว็บ "ค่าครองชีพไทย": ดูดัชนีย้อนหลัง ผลพยากรณ์ และราคาเป็นบาท.

ข้อมูลอ่านจาก PostgreSQL ที่ Airflow โหลดไว้ ส่วน /api/predict เรียกโมเดล
Champion ที่ Airflow deploy ไว้ใน volume /models โดยสร้าง Feature ด้วย
col_08_features.py ไฟล์เดียวกับตอน Train
"""

from __future__ import annotations

import math
import os
import re
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import joblib
import pandas as pd
import psycopg2
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from col_08_features import FEATURE_COLUMNS, build_features, complete_rows, describe_artifact

MODEL_PATH = Path("/models/cost_of_living/current_model.pkl")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
# รูปแบบ area_key เช่น "province:50" หรือ "region:TG" ป้องกันค่าแปลกปลอมตั้งแต่ต้นทาง
AREA_KEY_PATTERN = re.compile(r"^(region|province):[0-9A-Z]{1,4}$")
COMMODITY_PATTERN = re.compile(r"^[0-9]{5}$")

app = FastAPI(
    title="Thai Cost of Living API",
    description="ดัชนีราคาผู้บริโภคไทยรายจังหวัด ผลพยากรณ์เดือนหน้า และราคาอาหารเป็นบาท",
    version="2.0.0",
)


# ---------------------------------------------------------------------------
# ฐานข้อมูล
# ---------------------------------------------------------------------------
@contextmanager
def _db() -> Iterator[Any]:
    """เปิด connection ต่อหนึ่ง request แล้วปิดเสมอ (ปริมาณผู้ใช้น้อย ไม่ต้องใช้ pool)."""
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    try:
        connection = psycopg2.connect(DATABASE_URL, connect_timeout=5)
    except psycopg2.OperationalError as exc:
        raise HTTPException(status_code=503, detail="Database is not reachable") from exc
    try:
        # ตั้งเป็น read-only ป้องกันไม่ให้ API แก้ข้อมูลโดยไม่ตั้งใจ
        connection.set_session(readonly=True, autocommit=True)
        yield connection
    finally:
        connection.close()


def _query(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    """รัน SELECT แบบ parameterized แล้วคืนผลเป็น list ของ dict."""
    with _db() as connection, connection.cursor() as cursor:
        try:
            cursor.execute(sql, params)
        except psycopg2.errors.UndefinedTable as exc:
            raise HTTPException(
                status_code=503,
                detail="Tables are missing. Run thai_cost_of_living_backfill first.",
            ) from exc
        columns = [column.name for column in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _parse_area_key(area_key: str) -> tuple[str, str]:
    """แยก area_key เป็น (area_type, area_code) และตรวจรูปแบบ."""
    if not AREA_KEY_PATTERN.match(area_key):
        raise HTTPException(status_code=422, detail="area_key must look like province:50 or region:TG")
    area_type, area_code = area_key.split(":", 1)
    return area_type, area_code


def _check_commodity(code: str) -> str:
    if not COMMODITY_PATTERN.match(code):
        raise HTTPException(status_code=422, detail="commodity_code must be 5 digits")
    return code


# ---------------------------------------------------------------------------
# โมเดล
# ---------------------------------------------------------------------------
def _model_file_info() -> dict[str, Any]:
    """ตรวจว่ามีโมเดลหรือไม่ และเวลาแก้ไขล่าสุด (UTC)."""
    if not MODEL_PATH.is_file():
        return {"exists": False, "last_modified": None}
    modified = datetime.fromtimestamp(MODEL_PATH.stat().st_mtime, tz=timezone.utc).isoformat()
    return {"exists": True, "last_modified": modified}


def _load_artifact() -> dict[str, Any]:
    """โหลดและตรวจโครงสร้างไฟล์โมเดลก่อนใช้งาน."""
    if not MODEL_PATH.is_file():
        raise HTTPException(
            status_code=503,
            detail="No deployed model yet. Run thai_cost_of_living_backfill first.",
        )
    try:
        artifact = joblib.load(MODEL_PATH)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The deployed model cannot be loaded") from exc
    # ลำดับ Feature ต้องตรงกับที่ API สร้าง ไม่เช่นนั้นผลทำนายจะผิดแบบเงียบ ๆ
    if not isinstance(artifact, dict) or artifact.get("feature_columns") != FEATURE_COLUMNS:
        raise HTTPException(status_code=503, detail="The deployed model schema is incompatible")
    if not hasattr(artifact.get("model"), "predict"):
        raise HTTPException(status_code=503, detail="The deployed model artifact is invalid")
    return artifact


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class PredictRequest(BaseModel):
    """คำขอพยากรณ์: เลือกพื้นที่และหมวดสินค้า API จะดึงประวัติ 14 เดือนจากฐานข้อมูลเอง."""

    model_config = ConfigDict(extra="forbid")  # ปฏิเสธ field ที่ไม่รู้จัก
    area_key: str = Field(..., examples=["province:50"])
    commodity_code: str = Field(..., examples=["11310"])


class PredictResponse(BaseModel):
    area_key: str
    commodity_code: str
    base_period: date
    target_period: date
    base_index: float
    predicted_change_pct: float
    predicted_index: float
    model_name: str
    model_trained_through: str | None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, Any]:
    """Docker ใช้ตรวจว่า API ยังตอบสนอง (ไม่ตรวจฐานข้อมูลเพื่อไม่ให้ container restart วน)."""
    return {"status": "ok", "model": _model_file_info()}


@app.get("/api/overview")
def overview() -> dict[str, Any]:
    """ตัวเลขสรุปบนหน้าเว็บ: จำนวนแถว เดือนล่าสุด และเงินเฟ้อทั่วไปของประเทศ."""
    stats = _query(
        """
        SELECT (SELECT COUNT(*) FROM cpi_monthly) AS cpi_rows,
               (SELECT MAX(period_date) FROM cpi_monthly) AS latest_period,
               (SELECT COUNT(DISTINCT area_code) FROM dim_area WHERE area_type = 'province') AS provinces,
               (SELECT change_yoy FROM cpi_monthly
                 WHERE area_type = 'region' AND area_code = 'TG' AND commodity_code = '00000'
                 ORDER BY period_date DESC LIMIT 1) AS headline_yoy,
               (SELECT change_yoy FROM cpi_monthly
                 WHERE area_type = 'region' AND area_code = 'TG' AND commodity_code = '10000'
                 ORDER BY period_date DESC LIMIT 1) AS food_yoy
        """
    )[0]
    metrics = _query(
        """
        SELECT rmse, baseline_rmse, direction_accuracy, run_at FROM cpi_model_metrics
        WHERE deployed ORDER BY run_at DESC LIMIT 1
        """
    )
    stats["model"] = metrics[0] if metrics else None
    stats["model_file"] = _model_file_info()
    return stats


@app.get("/api/areas")
def areas() -> list[dict[str, Any]]:
    """รายชื่อพื้นที่ทั้งหมด (ประเทศ/ภาค และจังหวัด)."""
    return _query(
        """
        SELECT area_type || ':' || area_code AS area_key, area_type, area_code, area_name, region_code
        FROM dim_area ORDER BY area_type DESC, area_name
        """
    )


@app.get("/api/commodities")
def commodities(max_level: int = Query(3, ge=1, le=3)) -> list[dict[str, Any]]:
    """หมวดสินค้าในดัชนี เรียงตามรหัส."""
    return _query(
        "SELECT commodity_code, commodity_name, level FROM dim_commodity WHERE level <= %s ORDER BY commodity_code",
        (max_level,),
    )


@app.get("/api/series")
def series(
    area_key: str,
    commodity_code: str,
    months: int = Query(60, ge=6, le=600),
) -> dict[str, Any]:
    """ดัชนีย้อนหลังของพื้นที่ × หมวดสินค้า พร้อมผลพยากรณ์เดือนถัดไปล่าสุด."""
    area_type, area_code = _parse_area_key(area_key)
    _check_commodity(commodity_code)
    history = _query(
        """
        SELECT period_date, index_value, change_mom, change_yoy FROM (
            SELECT period_date, index_value, change_mom, change_yoy FROM cpi_monthly
            WHERE area_type = %s AND area_code = %s AND commodity_code = %s
            ORDER BY period_date DESC LIMIT %s
        ) recent ORDER BY period_date
        """,
        (area_type, area_code, commodity_code, months),
    )
    if not history:
        raise HTTPException(status_code=404, detail="No data for this area and commodity")
    forecast = _query(
        """
        SELECT base_period, target_period, base_index, predicted_index, predicted_change_pct
        FROM cpi_forecasts
        WHERE area_type = %s AND area_code = %s AND commodity_code = %s
        ORDER BY target_period DESC LIMIT 1
        """,
        (area_type, area_code, commodity_code),
    )
    return {"history": history, "forecast": forecast[0] if forecast else None}


# ราคาสินค้าที่สำรวจล่าสุดเกินนี้ถือว่าเลิกสำรวจแล้ว ไม่แสดงเป็นราคาปัจจุบัน
ACTIVE_PRICE_DAYS = 180


@app.get("/api/prices")
def prices() -> list[dict[str, Any]]:
    """ราคาขายปลีกจริงของกรมการค้าภายใน: ราคาล่าสุด, เทียบ 1 และ 5 ปีก่อน, เส้นย้อนหลัง 24 เดือน
    และราคาคาดการณ์เดือนหน้า (ราคาจริงล่าสุด × % ที่โมเดลคาดของหมวดสินค้านั้น ในกรุงเทพฯ และปริมณฑล)."""
    return _query(
        """
        WITH latest_day AS (
            SELECT DISTINCT ON (product_id) product_id, price_date, price_min, price_max
            FROM retail_prices_daily ORDER BY product_id, price_date DESC
        ),
        latest_month AS (
            SELECT DISTINCT ON (product_id) product_id, period_date
            FROM retail_price_monthly ORDER BY product_id, period_date DESC
        ),
        forecast AS (
            SELECT commodity_code, predicted_change_pct, target_period FROM cpi_forecasts
            WHERE area_type = 'region' AND area_code = '10'
              AND target_period = (SELECT MAX(target_period) FROM cpi_forecasts)
        )
        SELECT p.product_id, p.label, p.unit, p.product_group, p.cpi_code,
               d.price_date, d.price_min, d.price_max,
               (d.price_min + d.price_max) / 2 AS latest_price,
               y1.avg_price AS price_1y_ago, y5.avg_price AS price_5y_ago,
               ARRAY(
                   SELECT m.avg_price FROM retail_price_monthly m
                   WHERE m.product_id = p.product_id AND m.period_date > lm.period_date - INTERVAL '24 months'
                   ORDER BY m.period_date
               ) AS spark,
               f.predicted_change_pct, f.target_period,
               (d.price_min + d.price_max) / 2 * (1 + f.predicted_change_pct / 100) AS next_month_price
        FROM dim_product p
        JOIN latest_day d USING (product_id)
        JOIN latest_month lm USING (product_id)
        LEFT JOIN retail_price_monthly y1
          ON y1.product_id = p.product_id AND y1.period_date = lm.period_date - INTERVAL '12 months'
        LEFT JOIN retail_price_monthly y5
          ON y5.product_id = p.product_id AND y5.period_date = lm.period_date - INTERVAL '60 months'
        LEFT JOIN forecast f ON f.commodity_code = p.cpi_code
        WHERE d.price_date > CURRENT_DATE - %s * INTERVAL '1 day'
        ORDER BY p.product_id
        """,
        (ACTIVE_PRICE_DAYS,),
    )


@app.post("/api/predict", response_model=PredictResponse)
def predict(payload: PredictRequest) -> PredictResponse:
    """เรียกโมเดลสด ๆ: ดึง 14 เดือนล่าสุด สร้าง Feature แล้วทำนาย % เปลี่ยนแปลงเดือนหน้า."""
    area_type, area_code = _parse_area_key(payload.area_key)
    _check_commodity(payload.commodity_code)
    artifact = _load_artifact()

    # ต้องใช้ series ของประเทศ (TG) หมวดเดียวกันด้วย เพื่อคำนวณ national_chg_1
    rows = _query(
        """
        SELECT c.area_type, c.area_code, c.commodity_code, d.level, c.period_date, c.index_value
        FROM cpi_monthly c JOIN dim_commodity d USING (commodity_code)
        WHERE c.commodity_code = %s
          AND ((c.area_type = %s AND c.area_code = %s) OR (c.area_type = 'region' AND c.area_code = 'TG'))
          AND c.period_date > (
              SELECT MAX(period_date) FROM cpi_monthly
              WHERE area_type = %s AND area_code = %s AND commodity_code = %s
          ) - INTERVAL '14 months'
        """,
        (payload.commodity_code, area_type, area_code, area_type, area_code, payload.commodity_code),
    )
    frame = pd.DataFrame(rows)
    if frame.empty:
        raise HTTPException(status_code=404, detail="No data for this area and commodity")
    features, _ = build_features(frame, artifact["categories"])
    target_rows = features[
        (features["area_type"] == area_type) & (features["area_code"] == area_code)
    ]
    latest = target_rows[target_rows["period_date"] == target_rows["period_date"].max()]
    if latest.empty or not bool(complete_rows(latest).iloc[0]):
        raise HTTPException(status_code=422, detail="Need 13 consecutive months of history to predict")

    change = float(artifact["model"].predict(latest[FEATURE_COLUMNS].to_numpy(dtype="float32"))[0])
    if not math.isfinite(change):
        raise HTTPException(status_code=503, detail="The model returned an invalid prediction")
    base_period = latest["period_date"].iloc[0].date()
    base_index = float(latest["index_value"].iloc[0])
    target_period = (pd.Timestamp(base_period) + pd.DateOffset(months=1)).date()
    return PredictResponse(
        area_key=payload.area_key,
        commodity_code=payload.commodity_code,
        base_period=base_period,
        target_period=target_period,
        base_index=round(base_index, 2),
        predicted_change_pct=round(change, 3),
        predicted_index=round(base_index * (1 + change / 100), 2),
        model_name=str(artifact.get("model_name")),
        model_trained_through=describe_artifact(artifact).get("trained_through"),
    )


# ---------------------------------------------------------------------------
# Dashboard endpoints
# ---------------------------------------------------------------------------
HEADLINE, FOOD, ENERGY = "00000", "10000", "92000"


@app.get("/api/dashboard/summary")
def dashboard_summary() -> dict[str, Any]:
    """ตัวเลขหลักของหน้าภาพรวม: เงินเฟ้อล่าสุด, เดือนก่อน, พยากรณ์ และปริมาณข้อมูล."""
    latest = _query(
        """
        SELECT MAX(period_date) AS period FROM cpi_monthly
        WHERE area_type = 'region' AND area_code = 'TG' AND commodity_code = %s
        """,
        (HEADLINE,),
    )[0]["period"]
    if latest is None:
        raise HTTPException(status_code=503, detail="No CPI data yet. Run thai_cost_of_living_backfill first.")
    rows = _query(
        """
        SELECT commodity_code, period_date, index_value, change_yoy, change_mom
        FROM cpi_monthly
        WHERE area_type = 'region' AND area_code = 'TG' AND commodity_code IN (%s, %s, %s)
          AND period_date > %s::DATE - INTERVAL '25 months'
        ORDER BY period_date
        """,
        (HEADLINE, FOOD, ENERGY, latest),
    )
    trend: dict[str, list[dict[str, Any]]] = {HEADLINE: [], FOOD: [], ENERGY: []}
    for row in rows:
        trend[row["commodity_code"]].append(
            {"period": row["period_date"], "yoy": row["change_yoy"], "mom": row["change_mom"], "index": row["index_value"]}
        )
    forecast = _query(
        """
        SELECT commodity_code, target_period, predicted_change_pct, predicted_index
        FROM cpi_forecasts
        WHERE area_type = 'region' AND area_code = 'TG' AND commodity_code IN (%s, %s)
          AND base_period = %s
        """,
        (HEADLINE, FOOD, latest),
    )
    volume = _query(
        """
        SELECT (SELECT COUNT(*) FROM cpi_monthly) AS cpi_rows,
               (SELECT COUNT(*) FROM dim_area WHERE area_type = 'province') AS provinces,
               (SELECT COUNT(*) FROM dim_commodity) AS commodities,
               (SELECT MIN(period_date) FROM cpi_monthly) AS first_period,
               (SELECT MAX(loaded_at) FROM etl_load_log) AS last_loaded
        """
    )[0]
    wage = _query(
        """
        SELECT period_date, nominal_wage, real_wage FROM real_wage_monthly
        WHERE province_code = '10' ORDER BY period_date
        """
    )
    return {
        "latest_period": latest,
        "trend": trend,
        "forecast": {row["commodity_code"]: row for row in forecast},
        "volume": volume,
        "bangkok_wage": {"first": wage[0], "latest": wage[-1]} if wage else None,
    }


@app.get("/api/national/series")
def national_series(
    codes: str = Query("00000,10000", max_length=200),
    area_key: str = "region:TG",
) -> dict[str, Any]:
    """ดัชนีรายเดือนทั้งหมดของหลายหมวดในพื้นที่เดียว ใช้วาดกราฟเส้นระยะยาว."""
    area_type, area_code = _parse_area_key(area_key)
    code_list = [_check_commodity(code.strip()) for code in codes.split(",") if code.strip()][:8]
    rows = _query(
        """
        SELECT c.commodity_code, d.commodity_name, c.period_date, c.index_value, c.change_yoy
        FROM cpi_monthly c JOIN dim_commodity d USING (commodity_code)
        WHERE c.area_type = %s AND c.area_code = %s AND c.commodity_code = ANY(%s)
          AND c.index_value BETWEEN 0.1 AND 1000
        ORDER BY c.commodity_code, c.period_date
        """,
        (area_type, area_code, code_list),
    )
    series: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = series.setdefault(row["commodity_code"], {"name": row["commodity_name"], "points": []})
        entry["points"].append([row["period_date"], row["index_value"], row["change_yoy"]])
    return {"area_key": area_key, "series": [{"code": code, **series[code]} for code in code_list if code in series]}


@app.get("/api/categories/yoy")
def categories_yoy(area_key: str = "region:TG", level: int = Query(2, ge=1, le=3)) -> dict[str, Any]:
    """อัตราเงินเฟ้อเทียบปีก่อนของทุกหมวดในเดือนล่าสุด."""
    area_type, area_code = _parse_area_key(area_key)
    rows = _query(
        """
        SELECT c.commodity_code, d.commodity_name, c.change_yoy, c.change_mom, c.index_value, c.period_date
        FROM cpi_monthly c JOIN dim_commodity d USING (commodity_code)
        WHERE c.area_type = %s AND c.area_code = %s AND d.level = %s
          AND c.commodity_code < '90000'  -- ตัดดัชนีพิเศษ เช่น CPI พื้นฐาน ออก
          AND c.change_yoy IS NOT NULL
          AND c.period_date = (SELECT MAX(period_date) FROM cpi_monthly WHERE area_type = %s AND area_code = %s)
        ORDER BY c.change_yoy DESC
        """,
        (area_type, area_code, level, area_type, area_code),
    )
    return {"period": rows[0]["period_date"] if rows else None, "items": rows}


@app.get("/api/map")
def province_map(commodity_code: str = "00000") -> dict[str, Any]:
    """ค่าเงินเฟ้อเดือนล่าสุดของทุกจังหวัด สำหรับแผนที่ (กรุงเทพฯ ใช้ดัชนีกรุงเทพฯ และปริมณฑล)."""
    _check_commodity(commodity_code)
    rows = _query(
        """
        WITH latest AS (
            SELECT MAX(period_date) AS period FROM cpi_monthly
            WHERE area_type = 'province' AND commodity_code = %s
        )
        SELECT a.area_code AS code, a.area_name AS name, c.change_yoy AS yoy, c.change_mom AS mom,
               c.index_value, c.period_date, f.predicted_change_pct
        FROM cpi_monthly c
        JOIN dim_area a USING (area_type, area_code)
        LEFT JOIN cpi_forecasts f
          ON f.area_type = c.area_type AND f.area_code = c.area_code
         AND f.commodity_code = c.commodity_code AND f.base_period = c.period_date
        WHERE c.commodity_code = %s AND c.period_date = (SELECT period FROM latest)
          AND (c.area_type = 'province' OR (c.area_type = 'region' AND c.area_code = '10'))
        ORDER BY c.change_yoy DESC NULLS LAST
        """,
        (commodity_code, commodity_code),
    )
    return {"period": rows[0]["period_date"] if rows else None, "items": rows}


@app.get("/api/forecast/top")
def forecast_top(area_key: str = "region:TG", n: int = Query(8, ge=3, le=20)) -> dict[str, Any]:
    """หมวดสินค้าที่โมเดลคาดว่าจะขึ้น/ลงมากที่สุดเดือนหน้า."""
    area_type, area_code = _parse_area_key(area_key)
    rows = _query(
        """
        SELECT f.commodity_code, d.commodity_name, f.predicted_change_pct, f.base_index,
               f.predicted_index, f.target_period
        FROM cpi_forecasts f JOIN dim_commodity d USING (commodity_code)
        WHERE f.area_type = %s AND f.area_code = %s AND d.level = 3
          AND f.target_period = (SELECT MAX(target_period) FROM cpi_forecasts)
        ORDER BY f.predicted_change_pct DESC
        """,
        (area_type, area_code),
    )
    return {"rising": rows[:n], "falling": list(reversed(rows[-n:])) if rows else []}


@app.get("/api/model/metrics")
def model_metrics() -> list[dict[str, Any]]:
    """ผลประเมินโมเดลทุกรอบที่ Airflow เทรน."""
    return _query(
        """
        SELECT run_at, run_id, rmse, mae, r2, baseline_rmse, direction_accuracy,
               training_rows, holdout_rows, deployed
        FROM cpi_model_metrics ORDER BY run_at
        """
    )


@app.get("/api/prices/history")
def price_history(product_id: str = Query(..., pattern=r"^[A-Z]\d{5}$")) -> dict[str, Any]:
    """ราคาจริงของสินค้าหนึ่งตัว: เฉลี่ยรายเดือนทั้งหมด + รายวัน 120 วันล่าสุด."""
    monthly = _query(
        """
        SELECT period_date, avg_price, low_price, high_price, days_observed
        FROM retail_price_monthly WHERE product_id = %s ORDER BY period_date
        """,
        (product_id,),
    )
    daily = _query(
        """
        SELECT price_date, price_min, price_max FROM retail_prices_daily
        WHERE product_id = %s AND price_date > (
            SELECT MAX(price_date) FROM retail_prices_daily WHERE product_id = %s
        ) - INTERVAL '120 days'
        ORDER BY price_date
        """,
        (product_id, product_id),
    )
    return {"product_id": product_id, "monthly": monthly, "daily": daily}


@app.get("/api/forecast/products")
def forecast_products(commodity_code: str = "10000", n: int = Query(12, ge=1, le=40)) -> dict[str, Any]:
    """สินค้าที่มีราคาจริงในหมวดที่เลือก พร้อมราคาคาดการณ์เดือนหน้าจากโมเดล."""
    _check_commodity(commodity_code)
    # หมวดย่อยมีรหัสขึ้นต้นเหมือนหมวดแม่ เช่น 11000 -> 11xxx, 00000 = ทุกหมวด
    prefix = commodity_code.rstrip("0")
    items = [
        item for item in prices()
        if item["cpi_code"].startswith(prefix) and item["next_month_price"] is not None
    ]
    # สินค้าที่คาดว่าราคาจะเปลี่ยนมากที่สุดขึ้นก่อน แต่ไม่เกิน 2 ตัวต่อหมวด
    # (สินค้าในหมวดเดียวกันได้ % เท่ากัน ถ้าไม่จำกัดจะเห็นแต่ส้มหลายเบอร์)
    items.sort(key=lambda item: abs(item["predicted_change_pct"]), reverse=True)
    picked: list[dict[str, Any]] = []
    per_category: dict[str, int] = {}
    for item in items:
        if per_category.get(item["cpi_code"], 0) < 2:
            per_category[item["cpi_code"]] = per_category.get(item["cpi_code"], 0) + 1
            picked.append(item)
    return {"total": len(items), "items": picked[:n]}


@app.get("/api/wage")
def wage(province_code: str = Query("10", pattern=r"^\d{2}$")) -> dict[str, Any]:
    """ค่าแรงขั้นต่ำตามประกาศ และค่าแรงที่แท้จริง (บาทของปี 2566) รายเดือน."""
    rows = _query(
        """
        SELECT period_date, nominal_wage, real_wage, cpi_all_items FROM real_wage_monthly
        WHERE province_code = %s ORDER BY period_date
        """,
        (province_code,),
    )
    name = _query(
        "SELECT province_name FROM minimum_wage WHERE province_code = %s ORDER BY effective_date DESC LIMIT 1",
        (province_code,),
    )
    return {"province_code": province_code, "province_name": name[0]["province_name"] if name else None, "points": rows}


@app.get("/api/wage/provinces")
def wage_provinces() -> list[dict[str, Any]]:
    """ค่าแรงล่าสุดของทุกจังหวัด เทียบค่าแรงที่แท้จริงกับเดือนแรกที่มีข้อมูล."""
    return _query(
        """
        WITH bounds AS (
            SELECT province_code, MIN(period_date) AS first_period, MAX(period_date) AS last_period
            FROM real_wage_monthly GROUP BY province_code
        )
        SELECT b.province_code, m.province_name, first.nominal_wage AS first_nominal,
               first.real_wage AS first_real, b.first_period, last.nominal_wage AS nominal_wage,
               last.real_wage AS real_wage, b.last_period,
               (last.real_wage / first.real_wage - 1) * 100 AS real_change_pct
        FROM bounds b
        JOIN real_wage_monthly first ON first.province_code = b.province_code AND first.period_date = b.first_period
        JOIN real_wage_monthly last ON last.province_code = b.province_code AND last.period_date = b.last_period
        JOIN LATERAL (
            SELECT province_name FROM minimum_wage mw WHERE mw.province_code = b.province_code
            ORDER BY effective_date DESC LIMIT 1
        ) m ON TRUE
        ORDER BY last.real_wage DESC
        """
    )


@app.get("/api/pipeline")
def pipeline() -> dict[str, Any]:
    """สถานะการโหลดข้อมูลล่าสุดของแต่ละแหล่ง และจำนวนแถวในแต่ละตาราง."""
    loads = _query(
        """
        SELECT DISTINCT ON (source) source, dag_id, run_id, rows_loaded, note, loaded_at
        FROM etl_load_log ORDER BY source, loaded_at DESC
        """
    )
    tables = _query(
        """
        SELECT 'cpi_monthly' AS name, COUNT(*) AS rows FROM cpi_monthly
        UNION ALL SELECT 'cpi_yearly_summary', COUNT(*) FROM cpi_yearly_summary
        UNION ALL SELECT 'cpi_forecasts', COUNT(*) FROM cpi_forecasts
        UNION ALL SELECT 'real_wage_monthly', COUNT(*) FROM real_wage_monthly
        UNION ALL SELECT 'minimum_wage', COUNT(*) FROM minimum_wage
        UNION ALL SELECT 'retail_prices_daily', COUNT(*) FROM retail_prices_daily
        UNION ALL SELECT 'retail_price_monthly', COUNT(*) FROM retail_price_monthly
        UNION ALL SELECT 'price_estimates', COUNT(*) FROM price_estimates
        UNION ALL SELECT 'farm_prices_monthly', COUNT(*) FROM farm_prices_monthly
        """
    )
    correlations = _query(
        """
        SELECT farm_item, cpi_code, lag_months, pearson_correlation, sample_size
        FROM farm_retail_correlation
        WHERE calculated_at = (SELECT MAX(calculated_at) FROM farm_retail_correlation)
        ORDER BY ABS(pearson_correlation) DESC
        """
    )
    return {"loads": loads, "tables": tables, "farm_correlations": correlations}


# หน้า dashboard เป็นไฟล์ static (HTML/CSS/JS) ในโฟลเดอร์ static/
STATIC_DIR = Path(__file__).with_name("static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    """หน้า dashboard หลัก."""
    return FileResponse(STATIC_DIR / "index.html")
