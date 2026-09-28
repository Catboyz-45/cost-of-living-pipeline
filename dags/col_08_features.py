"""ขั้นที่ 08: สร้าง Feature สำหรับโมเดลพยากรณ์ดัชนีราคาเดือนถัดไป.

ไฟล์นี้ใช้แค่ numpy/pandas ไม่ import Airflow เพื่อให้ Model API (FastAPI)
ใช้โค้ดชุดเดียวกันได้ Feature ตอน Train และตอนทำนายจริงจึงตรงกันเสมอ
"""

from typing import Any

import numpy as np
import pandas as pd

# ลำดับ Feature ต้องตรงกันทั้งตอน Train, Forecast และใน Model API
FEATURE_COLUMNS = [
    "chg_1",  # % เปลี่ยนแปลงเดือนล่าสุด (t เทียบ t-1)
    "chg_2",  # % เปลี่ยนแปลง t-1 เทียบ t-2
    "chg_3",  # % เปลี่ยนแปลง t-2 เทียบ t-3
    "chg_6",  # % เปลี่ยนแปลงสะสม 6 เดือน
    "chg_12",  # % เปลี่ยนแปลงเทียบเดือนเดียวกันปีก่อน
    "seasonal_next",  # % เปลี่ยนแปลงของ "เดือนถัดไป" เมื่อปีที่แล้ว (ฤดูกาล)
    "national_chg_1",  # % เปลี่ยนแปลงเดือนล่าสุดของหมวดเดียวกันระดับประเทศ
    "month",  # เดือนของ t (1-12)
    "level",  # ระดับหมวดดัชนี
    "commodity_cat",  # หมวดสินค้า (categorical)
    "area_cat",  # พื้นที่ (categorical)
]
CATEGORICAL_FEATURES = ["commodity_cat", "area_cat"]
KEY_COLUMNS = ["area_type", "area_code", "commodity_code"]
INPUT_COLUMNS = [*KEY_COLUMNS, "level", "period_date", "index_value"]


def _pct(newer: pd.Series, older: pd.Series) -> pd.Series:
    """% เปลี่ยนแปลงจาก older ไป newer."""
    return (newer / older - 1.0) * 100.0


def build_features(
    frame: pd.DataFrame,
    categories: dict[str, dict[str, int]] | None = None,
) -> tuple[pd.DataFrame, dict[str, dict[str, int]]]:
    """แปลงดัชนีรายเดือน (long format) เป็นตาราง Feature หนึ่งแถวต่อ series ต่อเดือน.

    frame ต้องมีคอลัมน์ INPUT_COLUMNS ถ้ามีแถวของประเทศ (region/TG) อยู่ด้วย
    จะใช้คำนวณ national_chg_1 ส่วน target คือ % เปลี่ยนแปลงของเดือนถัดไป
    (เป็น NaN ในเดือนล่าสุด เพราะยังไม่รู้อนาคต)
    """
    missing = set(INPUT_COLUMNS) - set(frame.columns)
    if missing:
        raise ValueError(f"Missing input columns: {sorted(missing)}")

    data = frame[INPUT_COLUMNS].copy()
    data["period_date"] = pd.to_datetime(data["period_date"])
    data = data.sort_values([*KEY_COLUMNS, "period_date"]).reset_index(drop=True)
    data["index_value"] = data["index_value"].astype("float64")
    # เลขเดือนต่อเนื่อง ใช้ตรวจว่า shift แล้วได้เดือนที่ติดกันจริง (บางเดือนต้นทางไม่มีข้อมูล)
    month_number = data["period_date"].dt.year * 12 + data["period_date"].dt.month
    grouped_index = data.groupby(KEY_COLUMNS, sort=False)["index_value"]
    grouped_month = month_number.groupby([data[column] for column in KEY_COLUMNS], sort=False)

    def lag(steps: int) -> pd.Series:
        """ค่าดัชนีย้อนหลัง steps เดือน ถ้าเดือนไม่ต่อเนื่องจะเป็น NaN."""
        shifted = grouped_index.shift(steps)
        valid = grouped_month.shift(steps) == month_number - steps
        return shifted.where(valid)

    index_now = data["index_value"]
    lags = {steps: lag(steps) for steps in (1, 2, 3, 6, 11, 12)}
    data["chg_1"] = _pct(index_now, lags[1])
    data["chg_2"] = _pct(lags[1], lags[2])
    data["chg_3"] = _pct(lags[2], lags[3])
    data["chg_6"] = _pct(index_now, lags[6])
    data["chg_12"] = _pct(index_now, lags[12])
    data["seasonal_next"] = _pct(lags[11], lags[12])
    data["target"] = _pct(lag(-1), index_now)

    # national_chg_1: การเปลี่ยนแปลงของหมวดเดียวกันทั้งประเทศ ณ เดือนเดียวกัน
    national = data.loc[
        (data["area_type"] == "region") & (data["area_code"] == "TG"),
        ["commodity_code", "period_date", "chg_1"],
    ].rename(columns={"chg_1": "national_chg_1"})
    data = data.merge(national, on=["commodity_code", "period_date"], how="left")

    data["month"] = data["period_date"].dt.month
    data["level"] = data["level"].astype("float64")

    # categorical ต้องเป็นเลขจำนวนเต็มเล็ก ๆ ; หมวดที่ไม่เคยเห็นตอน Train จะเป็น NaN
    area_key = data["area_type"] + ":" + data["area_code"]
    if categories is None:
        categories = {
            "commodity": {code: i for i, code in enumerate(sorted(data["commodity_code"].unique()))},
            "area": {code: i for i, code in enumerate(sorted(area_key.unique()))},
        }
    data["commodity_cat"] = data["commodity_code"].map(categories["commodity"])
    data["area_cat"] = area_key.map(categories["area"])

    # float32 ลดหน่วยความจำลงครึ่งหนึ่ง สำคัญมากเมื่อมีหลายล้านแถว
    for column in FEATURE_COLUMNS + ["target"]:
        data[column] = data[column].astype("float32")
    data = data.replace([np.inf, -np.inf], np.nan)
    return data, categories


def complete_rows(features: pd.DataFrame) -> pd.Series:
    """แถวที่มี Feature ต่อเนื่องครบ (ไม่นับ national_chg_1 ที่ยอมให้ว่างได้)."""
    required = [column for column in FEATURE_COLUMNS if column != "national_chg_1"]
    return features[required].notna().all(axis=1)


def describe_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    """สรุปข้อมูลโมเดลสำหรับหน้า health/metadata โดยไม่เปิดเผย object โมเดล."""
    return {
        "model_name": artifact.get("model_name"),
        "trained_through": artifact.get("trained_through"),
        "created_at": artifact.get("created_at"),
        "feature_columns": artifact.get("feature_columns"),
        "training_rows": artifact.get("training_rows"),
    }
