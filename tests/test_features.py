"""Unit test ของฟังก์ชันที่ไม่ต้องใช้ฐานข้อมูล รันใน Airflow container ได้ด้วย

    docker cp tests airflow_scheduler:/tmp/tests
    docker exec airflow_scheduler python -m pytest -q /tmp/tests
"""

import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

# ให้ import โมดูลในโฟลเดอร์ dags ได้เหมือนตอน Airflow รัน (ทั้งบนเครื่องและใน container)
for candidate in (Path(__file__).resolve().parents[1] / "dags", Path("/opt/airflow/dags")):
    if candidate.is_dir():
        sys.path.insert(0, str(candidate))

from col_01_utils import be_to_ce, iter_months, parse_thai_date, shift_month  # noqa: E402
from col_08_features import FEATURE_COLUMNS, build_features, complete_rows  # noqa: E402


def test_parse_thai_date_formats_from_government_files():
    # รูปแบบจริงที่พบในไฟล์ค่าจ้างขั้นต่ำของกระทรวงแรงงาน
    assert parse_thai_date("1-เม.ย.-55") == date(2012, 4, 1)
    assert parse_thai_date("1 ม.ค. 63") == date(2020, 1, 1)
    assert parse_thai_date("31-ต.ค.-2559") == date(2016, 10, 31)
    with pytest.raises(ValueError):
        parse_thai_date("not a date")


def test_month_helpers_cross_year_boundary():
    assert be_to_ce(2569) == 2026
    assert shift_month(2569, 1, -1) == (2568, 12)
    assert shift_month(2568, 12, 1) == (2569, 1)
    assert list(iter_months((2568, 11), (2569, 2))) == [
        (2568, 11), (2568, 12), (2569, 1), (2569, 2),
    ]


def _series(area_type, area_code, values, start="2020-01-01"):
    periods = pd.date_range(start, periods=len(values), freq="MS")
    return pd.DataFrame({
        "area_type": area_type,
        "area_code": area_code,
        "commodity_code": "11310",
        "level": 3,
        "period_date": periods,
        "index_value": values,
    })


def test_build_features_lags_target_and_national_join():
    # ดัชนีขึ้นเดือนละ 1 จุด จึงคำนวณค่าที่ถูกต้องได้ง่าย
    province = _series("province", "50", [100 + i for i in range(15)])
    national = _series("region", "TG", [200 + 2 * i for i in range(15)])
    features, categories = build_features(pd.concat([province, national]))

    row = features[(features["area_code"] == "50") & (features["period_date"] == "2021-01-01")].iloc[0]
    # t = ม.ค. 2021 (ดัชนี 112), t-1 = 111, t-12 = 100, t+1 = 113
    assert row["chg_1"] == pytest.approx((112 / 111 - 1) * 100, rel=1e-5)
    assert row["chg_12"] == pytest.approx(12.0, rel=1e-5)
    assert row["target"] == pytest.approx((113 / 112 - 1) * 100, rel=1e-5)
    assert row["national_chg_1"] == pytest.approx((224 / 222 - 1) * 100, rel=1e-5)
    assert row["month"] == 1
    assert set(categories["area"]) == {"province:50", "region:TG"}
    assert list(features.columns[: len(features.columns)]).count("target") == 1
    assert all(column in features.columns for column in FEATURE_COLUMNS)


def test_gap_in_months_invalidates_lags():
    # เดือนที่ขาดหาย ต้องไม่ถูกนับเป็นเดือนติดกัน
    frame = _series("province", "50", [100 + i for i in range(15)])
    frame = frame[frame["period_date"] != "2020-12-01"]
    features, _ = build_features(frame)
    january = features[features["period_date"] == "2021-01-01"].iloc[0]
    assert pd.isna(january["chg_1"])
    assert not bool(complete_rows(features[features["period_date"] == "2021-01-01"]).iloc[0])


def test_unknown_category_becomes_missing_not_wrong_code():
    frame = _series("province", "50", [100 + i for i in range(15)])
    _, categories = build_features(frame)
    other = _series("province", "96", [100 + i for i in range(15)])
    features, _ = build_features(other, categories)
    assert features["area_cat"].isna().all()
