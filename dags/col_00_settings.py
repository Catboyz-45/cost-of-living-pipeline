"""ขั้นที่ 00: ค่าตั้งต้นที่ทุก Task ของโปรเจกต์ค่าครองชีพไทยใช้ร่วมกัน."""

from datetime import timedelta
from pathlib import Path

# ชื่อ Connection ต้องตรงกับ AIRFLOW_CONN_POSTGRES_TARGET ใน docker-compose.yaml
POSTGRES_CONN_ID = "postgres_target"

# ---------------------------------------------------------------------------
# โฟลเดอร์ภายใน Airflow container (mount มาจากเครื่อง host ใน docker-compose)
# ---------------------------------------------------------------------------
DATA_DIR = Path("/opt/airflow/data")
RAW_DIR = DATA_DIR / "raw"  # Bronze layer: เก็บ response ดิบจาก API แบบ gzip
SEED_DIR = DATA_DIR / "seed"  # ไฟล์ที่คนเตรียมเอง เช่น ค่าแรงเพิ่มเติม
EXPORT_DIR = Path("/opt/airflow/exports")  # CSV สำหรับอัปโหลดเข้า Power BI
MODEL_DIR = Path("/opt/airflow/models/cost_of_living")
CURRENT_MODEL_PATH = MODEL_DIR / "current_model.pkl"
MODEL_NAME = "cpi_next_month_change"

# ---------------------------------------------------------------------------
# แหล่งข้อมูลที่ 1: สำนักงานนโยบายและยุทธศาสตร์การค้า (สนค.) — ดัชนีราคาผู้บริโภค
# เอกสาร API: https://index.tpso.go.th/document/cpig/post-month
# ---------------------------------------------------------------------------
TPSO_API_BASE = "https://index-api.tpso.go.th/OpenApi"
CPI_YEAR_BASE = 2566  # ปีฐานปัจจุบันของดัชนี (ปี 2566 = 100)

# สองชุดข้อมูลใช้รูปแบบ request/response เดียวกัน ต่างกันแค่ path และช่วงปี
CPI_DATASETS = {
    # ระดับประเทศ/ภาค: TG=ทั้งประเทศ, 10=กทม.และปริมณฑล, CC, NN, EE, SS
    "cpig": {
        "path": "Cpig/Month",
        "area_type": "region",
        "start_year_be": 2519,
    },
    # ระดับจังหวัด 76 จังหวัด (กรุงเทพฯ อยู่ในชุด cpig รหัส 10)
    "cpip": {
        "path": "Cpip/Month",
        "area_type": "province",
        "start_year_be": 2541,
    },
}

# Backfill แบ่งช่วงปีเป็นหลายก้อนเพื่อให้ Airflow รันขนานกันได้
# None = ไปจนถึงเดือนล่าสุดที่ สนค. เผยแพร่ (อ่านจาก MasterData ตอนรัน)
PROVINCE_BACKFILL_CHUNKS = [
    (2541, 2545),
    (2546, 2550),
    (2551, 2555),
    (2556, 2560),
    (2561, 2565),
    (2566, None),
]

# รอบรายเดือนดึงย้อนหลัง N เดือน เพราะ สนค. อาจปรับตัวเลขเดือนก่อนหน้า
INCREMENTAL_MONTHS = 4

# เดือนที่เก่ากว่านี้ถือว่าคงที่แล้ว ถ้ามีไฟล์ใน Bronze จะใช้ซ้ำไม่เรียก API ใหม่
CACHE_STABLE_AFTER_MONTHS = 13

# เว้นระยะระหว่าง request เพื่อไม่ส่งภาระให้เซิร์ฟเวอร์ภาครัฐมากเกินไป
REQUEST_PAUSE_SECONDS = 0.15

# ---------------------------------------------------------------------------
# แหล่งข้อมูลที่ 2: กรมการค้าภายใน (MOC Open Data) — ราคาขายปลีกรายวันเป็นบาท
# API นี้ล่มบ่อย จึงออกแบบให้ล้มเหลวแบบนุ่มนวล (soft fail) และมี circuit breaker
# ---------------------------------------------------------------------------
MOC_PRICE_URL = "https://dataapi.moc.go.th/gis-product-prices"
MOC_TIMEOUT = (10, 60)
MOC_MAX_CONSECUTIVE_FAILURES = 3  # ล้มติดกันเกินนี้ให้หยุดเรียก API ในรอบนั้น
MOC_BACKFILL_START_YEAR = 2015  # ค.ศ. ช่วงเริ่มต้นของราคาขายปลีกย้อนหลัง
MOC_INCREMENTAL_DAYS = 120

# แหล่งข้อมูลที่ 2b: หน้าเว็บค้นหาราคาของกรมการค้าภายใน (web scraping)
# หน้าเว็บนี้ใช้ได้แม้ API ด้านบนล่ม และมีสินค้าขายปลีกหลายร้อยรายการ
# robots.txt ของเว็บไม่ได้ห้าม แต่ยังดึงแบบสุภาพ: เว้นระยะ, ระบุตัวตน, เก็บ cache ไม่ยิงซ้ำ
MOC_WEB_URL = "https://data.moc.go.th/OpenData/GISProductPrice"
MOC_WEB_USER_AGENT = "KU-student-thai-cost-of-living/1.0 (educational project; low rate)"
MOC_WEB_PAUSE_SECONDS = 1.0
MOC_WEB_WINDOW_YEARS = 2  # หนึ่ง request ขอได้ 2 ปี (ทดสอบแล้วตอบภายใน 1 วินาที)
MOC_WEB_MAX_CONSECUTIVE_FAILURES = 5  # ล้มติดกันเกินนี้ถือว่าเว็บล่ม ให้หยุดรอบนั้น
MOC_WEB_STABLE_AFTER_DAYS = 400  # ช่วงเวลาที่จบไปนานแล้วราคาไม่เปลี่ยน ใช้ cache ได้
# แบ่ง Task ตามกลุ่มรหัสสินค้า ให้ scrape ขนานกัน 3 Task
# เลือกเฉพาะ "ขายปลีก" (P = อาหารสด/ของแห้ง, R13 = ข้าวสารขายปลีก)
# R11/R12 เป็นราคาขายส่งต่อ 100 กก. และ W = ขายส่ง จึงไม่ดึง
MOC_WEB_PRODUCT_GROUPS = {
    "meat_seafood": ("P11", "P12"),
    "vegetables_fruit": ("P13", "P14"),
    "pantry_rice": ("P15", "P16", "R13"),
}

# สินค้าที่ใช้เป็น "ราคาอ้างอิง" แปลงดัชนีเป็นบาท
# product_id มาจาก https://dataapi.moc.go.th/gis-products (ขายปลีก)
# cpi_code คือรหัสหมวดดัชนีของ สนค. ที่สินค้านั้นเป็นตัวแทน
ANCHOR_PRODUCTS = [
    {"product_id": "P11028", "cpi_code": "11310", "label": "ไข่ไก่ เบอร์ 3"},
    {"product_id": "P11003", "cpi_code": "11211", "label": "หมูเนื้อแดง สะโพก"},
    {"product_id": "P11005", "cpi_code": "11211", "label": "หมูสามชั้น"},
    {"product_id": "P11012", "cpi_code": "11221", "label": "อกไก่ (เนื้อล้วน)"},
    {"product_id": "P11010", "cpi_code": "11221", "label": "ไก่สดทั้งตัว"},
    {"product_id": "P12014", "cpi_code": "11232", "label": "ปลาทูสด"},
    {"product_id": "P12017", "cpi_code": "11231", "label": "ปลานิล"},
    {"product_id": "P13001", "cpi_code": "11411", "label": "ผักคะน้า"},
    {"product_id": "P13003", "cpi_code": "11411", "label": "ผักบุ้งจีน"},
    {"product_id": "P13043", "cpi_code": "11411", "label": "มะนาว เบอร์ 1-2"},
    {"product_id": "R13005", "cpi_code": "11110", "label": "ข้าวสารเจ้า 5%"},
    {"product_id": "R13001", "cpi_code": "11110", "label": "ข้าวหอมมะลิ 100%"},
    {"product_id": "P16011", "cpi_code": "11521", "label": "น้ำมันปาล์ม ขวด 1 ลิตร"},
    {"product_id": "P14006", "cpi_code": "11421", "label": "กล้วยหอมทอง"},
]

# ราคาของกรมการค้าภายในเก็บจากตลาดในกรุงเทพฯ จึงใช้ดัชนีพื้นที่ "10" มาแปลง
ANCHOR_AREA_TYPE = "region"
ANCHOR_AREA_CODE = "10"

# ---------------------------------------------------------------------------
# แหล่งข้อมูลที่ 3-4: data.go.th (CKAN API) — resolve URL ไฟล์ล่าสุดตอนรันจริง
# ---------------------------------------------------------------------------
DATA_GO_TH_PACKAGE_URL = "https://data.go.th/api/3/action/package_show"

# ค่าจ้างขั้นต่ำรายจังหวัด ครบ 77 จังหวัด เผยแพร่โดยสำนักงานปลัดกระทรวงแรงงาน
# ค่า = วันสุดท้ายที่อัตรานั้นมีผล (ค.ศ.) ถ้า None จะใช้วันก่อนประกาศถัดไป
# หรือสิ้นปีของวันที่มีผล กรณีที่ยังไม่มีประกาศถัดไปในฐานข้อมูล
MINIMUM_WAGE_PACKAGES = {
    "item_cf788773-99c9-4c7a-8bb5-0f6ee763b024": None,  # ปี 2556 (ถึงก่อนประกาศปี 2560)
    # ปี 2560: ประกาศฉบับที่ 9 มีผล 1 เม.ย. 2561 ตามเว็บ lb.mol.go.th
    "item_68e80374-1b78-4462-9fb0-e786579e87fe": "2018-03-31",
    "wage-rate2563": None,  # ปี 2563
}
# ประกาศฉบับที่ 9, 11-14 มีแต่ PDF จึงแปลงเป็นไฟล์นี้ด้วย scripts/build_minimum_wage_seed.py
MINIMUM_WAGE_EXTRA_CSV = SEED_DIR / "minimum_wage_extra.csv"
# วันที่ตรวจแล้วว่าประกาศล่าสุดในฐานข้อมูล (ฉบับที่ 14) ยังเป็นฉบับปัจจุบันบน mol.go.th
# อัตราที่ไม่มีประกาศถัดไปจะถือว่าใช้ได้ถึงวันนี้ ถ้ามีประกาศใหม่ให้เพิ่มแถวแล้วเลื่อนวันที่นี้
MINIMUM_WAGE_CURRENT_AS_OF = "2026-09-28"

# ราคาสินค้าปศุสัตว์ที่เกษตรกรขายได้ รายเดือน (กรมปศุสัตว์)
FARM_PRICE_PACKAGE = "econ_21_01"

# ---------------------------------------------------------------------------
# Data Quality และ ML
# ---------------------------------------------------------------------------
MIN_TOTAL_CPI_ROWS = 1_000_000  # ต้องมีข้อมูลหลักล้านแถวตามโจทย์ก่อนเริ่มเทรน
MIN_PROVINCES = 70
INDEX_MIN, INDEX_MAX = 0.1, 1000.0  # ช่วงค่าดัชนีที่สมเหตุสมผล (ปีฐาน 2566 = 100)
# ต้นทางมีดัชนีผิดปกติบางหมวดในอดีต (เช่น อุปกรณ์การศึกษาปี 2544-2552 เกิน 7,000)
# ถ้าสัดส่วนไม่เกินค่านี้ให้เตือนแล้วตัดออกจากการวิเคราะห์ ถ้าเกินให้หยุด pipeline
MAX_OUT_OF_RANGE_SHARE = 0.001

ML_START_YEAR_BE = 2548  # ใช้ข้อมูลตั้งแต่ปีนี้เทรน (ต้องมี lag 12 เดือน)
ML_MAX_LEVEL = 3  # ระดับหมวดดัชนีสูงสุดที่ใช้ (1=รวม, 2=หมวดใหญ่, 3=หมวดย่อย)
ML_HOLDOUT_MONTHS = 12  # เดือนล่าสุดที่เก็บไว้ทดสอบ (แบ่งตามเวลา)
ML_TARGET_CLIP = 30.0  # ตัด outlier ของ % เปลี่ยนแปลงรายเดือนที่เกิน ±30%
# รายชื่อ Feature อยู่ใน col_08_features.py เพราะ Model API ต้องใช้ไฟล์เดียวกัน

# ถ้า Task ล้มเหลว Airflow จะลองใหม่ 2 ครั้ง เว้นรอบละ 2 นาที
DEFAULT_ARGS = {
    "owner": "cost-of-living-project",
    "retries": 2,
    "retry_delay": timedelta(minutes=2),
}
