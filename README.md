# ค่าครองชีพไทย (Thai Cost of Living Pipeline)

โปรเจกต์ Apache Airflow ที่ดึง **ดัชนีราคาผู้บริโภคไทยรายจังหวัด หลักล้านแถว** จากแหล่งข้อมูลทางการ แปลงดัชนีเป็น **ราคาอาหารเป็นบาท** เทียบกับ **ค่าแรงขั้นต่ำ** และเทรนโมเดล ML พยากรณ์ว่า **เดือนหน้าของแต่ละหมวดในแต่ละจังหวัดจะแพงขึ้นหรือถูกลง** แล้วส่งผลออกเป็น CSV สำหรับ Power BI และหน้าเว็บ FastAPI

โปรเจกต์ตอบ 3 คำถาม:

1. **ย้อนหลัง:** ข้าว หมู ไข่ อาหารนอกบ้าน ค่าเช่า น้ำมัน แพงขึ้นเท่าไหร่ ในจังหวัดไหน
2. **พยากรณ์:** เดือนหน้าราคาแต่ละหมวดจะขึ้นหรือลง
3. **กำลังซื้อ:** ค่าแรงขั้นต่ำซื้อของได้น้อยลงแค่ไหน (ค่าแรงที่แท้จริง และค่าแรง 1 วันซื้อไข่ได้กี่ฟอง)

## แหล่งข้อมูล (ข้อมูลจริงจากหน่วยงานรัฐทั้งหมด)

| ข้อมูล | หน่วยงาน | วิธีดึง | ขอบเขต |
|---|---|---|---|
| ดัชนีราคาผู้บริโภค (CPI) ระดับประเทศและ 5 ภาค | สำนักงานนโยบายและยุทธศาสตร์การค้า (สนค.) | [TPSO Open API](https://index.tpso.go.th/document/cpig/post-month) `POST /OpenApi/Cpig/Month` | รายเดือน ตั้งแต่ปี 2519, สูงสุด 194 หมวด |
| CPI ระดับจังหวัด | สนค. | `POST /OpenApi/Cpip/Month` | 76 จังหวัด รายเดือน ตั้งแต่ปี 2541, 106–173 หมวด (ไม่มีกรุงเทพฯ แยกเดี่ยว — API คืนค่าว่างเมื่อขอรหัส 10 จึงใช้ดัชนี "กรุงเทพฯ และปริมณฑล" จาก Cpig แทน รวมครบ 77) |
| ราคาขายปลีกรายวันเป็นบาท (เนื้อสัตว์ ไข่ สัตว์น้ำ ผัก ผลไม้ ของแห้ง น้ำมันพืช ข้าวสาร) | กรมการค้าภายใน | **Web scraping** หน้าค้นหาราคา [MOC Open Data](https://data.moc.go.th/OpenData/GISProductPrice) ด้วย `requests` + BeautifulSoup (สำรองด้วย API `GET /gis-product-prices` ซึ่งล่มบ่อย) | 283 สินค้าขายปลีก รายวัน ตั้งแต่ปี 2558 — 527,303 แถว |
| ค่าจ้างขั้นต่ำรายจังหวัด | สำนักงานปลัดกระทรวงแรงงาน / คณะกรรมการค่าจ้าง | data.go.th (CKAN API) + PDF ประกาศฉบับที่ 9, 11–14 | 77 จังหวัด ตั้งแต่ปี 2555 ถึงปัจจุบัน |
| ราคาสินค้าปศุสัตว์ที่เกษตรกรขายได้ | กรมปศุสัตว์ | data.go.th (CKAN API) | รายเดือน 2562–2568 |

ปีฐานของดัชนีคือ 2566 = 100 ทุกไฟล์ใช้ปีฐานเดียวกัน

## สถาปัตยกรรม

```text
 TPSO API ─┐                        ┌─> dim_area / dim_commodity / dim_product
 MOC API ──┤   Extract (ขนาน)       │
 data.go.th┘ ──> Bronze: data/raw ──┼─> Silver: cpi_monthly (หลักล้านแถว), retail_prices_daily,
                 (JSON.gz ดิบ)      │            minimum_wage, farm_prices_monthly
                                    │
                        Validate (Branch) ──> data_quality_alert
                                    │
                        Transform (SQL) ──> Gold: cpi_yearly_summary, price_estimates,
                                    │             real_wage_monthly, farm_retail_correlation
                                    │
            Train -> Evaluate -> Champion vs Challenger -> Deploy/Skip -> Smoke test
                                    │
                        Forecast เดือนหน้า -> cpi_forecasts
                                    │
                        Export CSV -> exports/ -> Power BI (เว็บ)
                                    │
                        Dashboard + API (FastAPI, localhost:8001) อ่าน DB สด + เรียกโมเดล
```

## ครอบคลุมทุกเรื่องที่เรียน

| หัวข้อ Workshop | ใช้ในโปรเจกต์ | ไฟล์ |
|---|---|---|
| DAG, schedule, catchup, `max_active_runs` | DAG backfill (`schedule=None`) และ DAG รายเดือน (`0 3 10 * *`, `catchup=False`) | `cost_of_living_*.py` |
| `BashOperator` | ตรวจ Python, สิทธิ์เขียนโฟลเดอร์ และพื้นที่ดิสก์เหลือ ≥ 2 GB | `col_09_pipeline.py` |
| `PythonOperator` + `op_kwargs` | Extract/Transform/ML ทุกขั้น | `col_03`–`col_07` |
| `EmptyOperator` | Task `finish` | `col_09_pipeline.py` |
| XCom (return / `xcom_push` key / `xcom_pull` list) | ส่ง metadata ของ Extract, รายงาน Data Quality, path โมเดล | `col_04`, `col_06` |
| `BranchPythonOperator` + `trigger_rule` | Data Quality ผ่าน/ไม่ผ่าน, Deploy/Skip, `none_failed_min_one_success` | `col_04`, `col_06`, `col_09` |
| Parallel tasks จาก loop | Extract 10 task ขนานกันใน `TaskGroup` | `cost_of_living_backfill.py` |
| `PostgresOperator` / `PostgresHook` | สร้าง schema, COPY + upsert, อ่านข้อมูลเทรน | `col_02`, `col_05`, `col_06` |
| ETL + retry | Session retry/backoff, `retries=2`, circuit breaker สำหรับ API ที่ล่มบ่อย | `col_01`, `col_03` |
| Web scraping | อ่านรายการสินค้าจาก `<select>` แล้วส่งฟอร์มค้นหา (GET) และอ่านตาราง HTML ด้วย BeautifulSoup แบ่ง 3 task ขนานกันตามกลุ่มสินค้า | `col_10_scrape.py` |
| ML pipeline | Chronological holdout, RMSE/MAE/R²/direction accuracy, baseline, Champion/Challenger, atomic deploy, smoke test, log metrics | `col_06_model.py` |
| Model serving | FastAPI + Pydantic validation + หน้าเว็บ ใน Docker แยก service | `model_service/` |
| Docker Compose | CeleryExecutor, Redis, Postgres metadata แยกจาก Postgres ปลายทาง, model API | `docker-compose.yaml` |

สิ่งที่เพิ่มจาก Workshop เพื่อรับข้อมูลหลักล้านแถว:
- โหลดด้วย `COPY` เข้า temp table แล้ว `INSERT ... ON CONFLICT` แทนการ insert ทีละแถว
- เก็บ Bronze layer เป็นไฟล์ gzip ถ้ารันซ้ำ ปีที่ข้อมูลคงที่แล้วจะอ่านจาก cache ไม่เรียก API ใหม่
- ส่งเฉพาะ path และสรุปผ่าน XCom เพราะข้อมูลใหญ่เกินจะส่งผ่าน XCom
- Transform ที่หนักทำด้วย SQL ใน PostgreSQL ส่วนการเทรนใช้ `float32` และ `HistGradientBoostingRegressor` เพื่อประหยัด RAM

## โครงสร้างไฟล์

```text
dags/
├── col_00_settings.py         # ค่าตั้งต้น, URL แหล่งข้อมูล, สินค้าอ้างอิง
├── col_01_utils.py            # แปลงปี พ.ศ./ค.ศ., วันที่ไทย, HTTP retry, gzip cache
├── col_02_database.py         # schema ทุกตาราง + bulk_upsert (COPY)
├── col_03_extract.py          # ดึง TPSO / MOC / data.go.th
├── col_04_validate.py         # Data Quality + Branch
├── col_05_transform.py        # ตารางสรุปรายปี, ราคาเป็นบาท, ค่าแรงที่แท้จริง, correlation
├── col_06_model.py            # Train/Evaluate/Champion/Deploy/Smoke/Forecast
├── col_07_export.py           # CSV สำหรับ Power BI
├── col_08_features.py         # Feature engineering (ใช้ร่วมกับ Model API)
├── col_09_pipeline.py         # ประกอบ Task ส่วนท้ายที่สอง DAG ใช้ร่วมกัน
├── col_10_scrape.py           # Web scraping ราคาขายปลีกจริงจากหน้าเว็บกรมการค้าภายใน
├── cost_of_living_backfill.py # DAG: thai_cost_of_living_backfill
└── cost_of_living_monthly.py  # DAG: thai_cost_of_living_monthly
model_service/
├── main.py                    # FastAPI: API ของ dashboard + /api/predict
└── static/                    # Dashboard (HTML/CSS/JS ล้วน) + ขอบเขตจังหวัด GeoJSON
data/seed/minimum_wage_extra.csv  # ค่าแรงขั้นต่ำฉบับที่ 9, 11–14 ที่แปลงจาก PDF
scripts/build_minimum_wage_seed.py # สคริปต์แปลง PDF ประกาศค่าแรง -> CSV (ตรวจครบ 77 จังหวัด)
docs/powerbi_guide.md          # วิธีทำ Dashboard
tests/test_features.py         # Unit test: feature engineering
tests/test_scrape.py           # Unit test: ตัวอ่าน HTML ของ web scraping
DESIGN.md                      # แนวดีไซน์ธีมสว่าง (จาก npx getdesign@latest add coinbase)
```

`.airflowignore` ทำให้ Airflow ไม่ต้อง parse ไฟล์ `col_XX_*.py` เพราะเป็นโมดูลช่วยงาน ไม่ใช่ DAG

## ลำดับ Task

```text
check_environment -> create_tables
        |
  extract (TaskGroup, รันขนาน)
  ├─ cpi_national_regions           (สนค. ประเทศ + ภาค)
  ├─ cpi_provinces_2541_2545 ... _latest   (สนค. จังหวัด 6 ช่วงปี)
  ├─ retail_prices                  (กรมการค้าภายใน, soft-fail)
  ├─ farm_prices                    (กรมปศุสัตว์, soft-fail)
  └─ minimum_wage                   (กระทรวงแรงงาน, soft-fail)
        |
 validate_extracted_data ──> data_quality_alert ──────────────┐
        |                                                     |
 transform_and_load -> train_model -> evaluate_model          |
        -> evaluate_champion -> decide_deployment             |
             ├─ deploy_model -> smoke_test ─┐                 |
             └─ skip_deployment ────────────┴─> log_model_result
                                                    |         |
                                  generate_forecasts -> export_powerbi -> finish
```

DAG รายเดือน (`thai_cost_of_living_monthly`) มี Task เหมือนกัน แต่ Extract ดึงแค่ 4 เดือนล่าสุด เผื่อต้นทางแก้ตัวเลขย้อนหลัง

## โมเดล ML

- **เป้าหมาย:** % เปลี่ยนแปลงของดัชนีเดือนหน้า ของทุกพื้นที่ × ทุกหมวด (ระดับ 1–3)
- **Feature:** % เปลี่ยนแปลง 1/2/3/6/12 เดือน, ฤดูกาลของเดือนถัดไปเมื่อปีก่อน, การเปลี่ยนแปลงของหมวดเดียวกันระดับประเทศ, เดือน, ระดับหมวด, หมวดสินค้าและพื้นที่ (categorical)
- **โมเดล:** `HistGradientBoostingRegressor` เทรนด้วยข้อมูลตั้งแต่ปี 2548 (หลายล้านแถว)
- **ทดสอบ:** ใช้ 12 เดือนล่าสุดเป็น holdout แบ่งตามเวลา เทียบกับ baseline "เดือนหน้าเท่าเดิม" และเทียบ Champion บน holdout **ชุดเดียวกัน**
- **Deploy:** ต้องชนะ baseline และ RMSE ต่ำกว่า Champion จึงคัดลอกเป็น `models/cost_of_living/current_model.pkl` แบบ atomic

## ผลจากการรัน backfill ครั้งแรก (28 ก.ย. 2569)

| รายการ | ผล |
|---|---|
| แถวใน `cpi_monthly` | **3,367,750 แถว** (6 พื้นที่ระดับประเทศ/ภาค + 76 จังหวัด, ข้อมูลถึง ส.ค. 2569) |
| เวลา Extract | ประมาณ 19 นาที (request รายปี ~2,500 ครั้ง) |
| ค่าดัชนีผิดปกติจากต้นทาง | 1,138 แถว (0.03%) Validate เตือนและตัดออกจากสรุป/ML |
| ข้อมูลเทรน / ทดสอบ | 2,528,896 / 162,777 แถว (ทดสอบ ส.ค. 2568 – ส.ค. 2569) |
| RMSE โมเดล vs baseline | **1.788 vs 1.969** (% เปลี่ยนแปลงรายเดือน ดีกว่า baseline ~9%) |
| ทายทิศทางขึ้น/ลงถูก | 59.8% ของเดือนที่ราคาเปลี่ยนจริง |
| ผลพยากรณ์ ก.ย. 2569 | 13,571 series (พื้นที่ × หมวด) |
| ค่าแรงที่แท้จริง กทม. (บาทปี 2566) | 345 บาท (เม.ย. 2555) → 333 บาท (ก.ค. 2565 ช่วงเงินเฟ้อสูง) → 389 บาท (ส.ค. 2569) |
| ราคาหน้าฟาร์ม vs ดัชนีขายปลีก | ไข่ r = 0.72, หมู r = 0.68 (เดือนเดียวกัน) |

ดัชนีราคารายเดือนแกว่งมาก โมเดลจึงอธิบายได้ส่วนหนึ่ง (R² ≈ 0.17) แต่ยังดีกว่าการทายว่า "ราคาเท่าเดิม" ซึ่งเป็นเงื่อนไขขั้นต่ำก่อน deploy

## ราคาเป็นบาท (ราคาจริงจาก Web scraping)

API ราคาของกรมการค้าภายในล่มเกือบทั้งวัน แต่หน้าเว็บค้นหาราคายังใช้ได้ และส่งผลเป็นตาราง HTML ที่ server สร้างมาแล้ว จึงดึงด้วย web scraping (`col_10_scrape.py`):

1. อ่านรายการสินค้า 729 รายการจาก dropdown ของหน้าเว็บ เลือกเฉพาะขายปลีก (P11–P16, R13)
2. ส่งฟอร์มค้นหาทีละสินค้า ทีละช่วง 2 ปี (2558–ปัจจุบัน) แล้วอ่านตารางราคาต่ำสุด/สูงสุดรายวัน
3. ดึงแบบสุภาพ: เว้น 1 วินาทีต่อ request, ระบุ User-Agent, robots.txt ของเว็บไม่ได้ห้าม, ช่วงที่จบไปนานแล้วอ่านจาก cache ใน Bronze layer ไม่ยิงซ้ำ
4. ตรวจคุณภาพ: รับเฉพาะหมวด "ขายปลีก" หน่วยเป็นบาท และราคาต่ำสุด ≤ สูงสุด (ข้าวขายส่งต่อ 100 กก. ถูกคัดออกอัตโนมัติ)
5. ถ้าเว็บล่ม/เปลี่ยนหน้าตา จะหยุดรอบนั้นโดยไม่ทำให้ DAG fail

ผลรอบแรก: 283 สินค้า 527,303 แถว (ใช้ 1,764 request ประมาณ 1.5 ชั่วโมง เพราะเว็บตอบหน้าละหลายวินาที) รอบรายเดือนยิงเฉพาะช่วงล่าสุด ส่วนที่เหลือใช้ cache
ตาราง gold `retail_price_monthly` สรุปราคาเฉลี่ยรายเดือนให้ dashboard และ Power BI

ราคาคาดการณ์เดือนหน้าของสินค้า = ราคาจริงล่าสุด × % ที่โมเดลคาดของหมวดสินค้านั้น (ดัชนีกรุงเทพฯ และปริมณฑล) จึงเป็นค่าประมาณ ส่วนหมวดที่ไม่มีราคาเป็นบาท (ค่าเดินทาง ค่าเล่าเรียน ฯลฯ) แสดงได้เฉพาะดัชนี

### ราคาประมาณจากดัชนี (ตาราง `price_estimates`)

สำหรับวิเคราะห์ย้อนก่อนปี 2558 ใช้ราคาจริงเป็นจุดอ้างอิงแล้วคูณด้วยดัชนี:

```text
ราคาเดือน t = ราคาจริงเดือนอ้างอิง × ดัชนีเดือน t ÷ ดัชนีเดือนอ้างอิง
```

ราคาของกรมการค้าภายในเก็บจากตลาดในกรุงเทพฯ จึงใช้ดัชนี "กรุงเทพฯ และปริมณฑล" แปลง ราคาย้อนหลังจึงเป็น **ค่าประมาณ** ของสินค้าตัวแทนของหมวดนั้น ไม่ใช่ราคาที่ถูกบันทึกจริงในอดีต

## เริ่มใช้งาน

1. สร้างไฟล์ environment (บน macOS/Linux เปลี่ยน `AIRFLOW_UID` เป็นผลของ `id -u` ได้)

   ```bash
   cp .env.example .env
   ```

2. เริ่มระบบ

   ```bash
   docker compose up airflow-init
   ```

   ```bash
   docker compose up -d --build
   ```

3. เปิด Airflow ที่ <http://localhost:8080> บัญชี development คือ `airflow / airflow`
4. Unpause และ Trigger `thai_cost_of_living_backfill` **หนึ่งครั้ง** ครั้งแรกใช้เวลาประมาณหนึ่งชั่วโมง ขึ้นกับความเร็ว API ของ สนค.
5. หลังรันเสร็จ Unpause `thai_cost_of_living_monthly` ให้รันเองทุกเดือน
6. เปิด **Dashboard** ที่ <http://localhost:8001> หรือ Swagger <http://localhost:8001/docs>
7. (ทางเลือก) ไฟล์สำหรับ Power BI อยู่ใน `exports/` ดูวิธีทำใน [docs/powerbi_guide.md](docs/powerbi_guide.md)

ไม่ควรรัน DAG backfill และ DAG รายเดือนพร้อมกัน เพราะทั้งสองเขียนตารางและไฟล์โมเดลชุดเดียวกัน

## Dashboard

Dashboard อยู่ใน `model_service/static/` ใช้ HTML/CSS/JavaScript ล้วน (ไม่มี library กราฟภายนอก) อ่านข้อมูลสดจาก PostgreSQL ผ่าน API ของ FastAPI จึงไม่ต้อง export หรือ refresh แบบ Power BI

เว็บแบ่งเป็น 2 ชั้น: 4 หน้าตอบคำถามของคนทั่วไปด้วยภาษาง่าย และ 1 หน้าเบื้องหลังระบบสำหรับอาจารย์/ผู้สนใจด้านเทคนิค
ทุกหน้ามีประโยคสรุปที่สร้างจากข้อมูลอัตโนมัติ ชื่อหมวดของ สนค. แปลงเป็นภาษาคน (เช่น "หมวดพาหนะ การขนส่ง และการสื่อสาร" → "เดินทางและสื่อสาร") และมีปุ่ม i อธิบายคำที่จำเป็นต้องใช้ เช่น เงินเฟ้อ ดัชนีราคา ค่าแรงเมื่อหักของแพง

| หน้า | ตอบคำถาม | แสดงอะไร |
|---|---|---|
| ของแพงขึ้นแค่ไหน | ตอนนี้ของแพงขึ้นเท่าไหร่ | เงินเฟ้อแบบ "ของ 100 บาทปีก่อน ตอนนี้ 102.53 บาท", อาหาร/พลังงาน, **ราคาจริงของกิน 233 รายการ** (ค้นหา/กรองกลุ่ม/กราฟย้อนหลังพร้อมแถบต่ำสุด-สูงสุด), ค่าใช้จ่ายเรื่องไหนแพงขึ้นมากสุด, ย้อนดูหลายปี |
| จังหวัดไหนแพงเร็ว | จังหวัดไหนของแพงขึ้นเร็วสุด | แผนที่ 77 จังหวัด เลือกเรื่องได้ + ตารางอันดับ + กดไปดูคาดการณ์ของจังหวัดนั้น |
| เดือนหน้าเป็นไง | เดือนหน้าจะแพงขึ้นไหม | ราคาของกินเดือนหน้า (ราคาจริง × % ที่โมเดลคาด), แนวโน้ม 5 ปี + ค่าที่โมเดลทาย, ปุ่มให้โมเดลทายใหม่สด ๆ, เรื่องที่คาดว่าขึ้น/ลงมากสุด, ความแม่นแบบภาษาง่าย |
| ค่าแรงพอไหม | ค่าแรงขั้นต่ำตามทันของแพงไหม | ค่าแรงวันนี้, ค่าแรงเมื่อหักของแพง, ซื้อของได้มากขึ้น/น้อยลงกี่ %, ค่าแรง 1 วันซื้อไข่/หมู/ข้าว/ผักได้เท่าไหร่, ตาราง 77 จังหวัด |
| เบื้องหลังระบบ | ระบบทำงานยังไง | ขั้นตอน Pipeline 5 ขั้น, จำนวนแถวทุกตาราง, เวลาโหลดล่าสุด, metric ของโมเดล (RMSE/MAE/R²/direction accuracy/baseline/Champion), correlation ราคาหน้าฟาร์ม, แหล่งข้อมูล |

ใช้ธีมสว่างแบบ Coinbase อย่างเดียว (ดีไซน์อ้างอิงจาก [DESIGN.md](DESIGN.md) ที่ได้จาก `npx getdesign@latest add coinbase`) รองรับจอมือถือ ขอบเขตจังหวัดมาจาก [OpenGISData-Thailand](https://github.com/chingchai/OpenGISData-Thailand) (repo ไม่ได้ระบุ license ไว้) ย่อจุดให้เหลือ 278 KB

## ค่าแรงขั้นต่ำ

- **ปี 2556, 2560, 2563:** DAG ดึงจาก data.go.th ของสำนักงานปลัดกระทรวงแรงงานโดยตรง
- **ฉบับที่ 9, 11, 12, 13:** มีเฉพาะ PDF จึงใช้ [scripts/build_minimum_wage_seed.py](scripts/build_minimum_wage_seed.py) อ่านตาราง แล้วบันทึกเป็น `data/seed/minimum_wage_extra.csv`
  - สคริปต์ตรวจว่าจำนวนจังหวัดทุกกลุ่มอัตราตรงกับตัวเลขในประกาศ และรวมได้ครบ 77 จังหวัด
  - อัตราเฉพาะอำเภอ (เช่น อ.เมืองเชียงใหม่ อ.หาดใหญ่ อ.เกาะสมุย) ไม่นับ ใช้อัตราทั่วไปของจังหวัดแทน
- **ฉบับที่ 14 (1 ก.ค. 2568):** ปรับอัตราทั่วไปเฉพาะกรุงเทพฯ เป็น 400 บาท (กิจการโรงแรมและสถานบริการทั่วประเทศไม่ใช่อัตราทั่วไป) ใส่เป็นแถวแยกพร้อมลิงก์แหล่งที่มา
- `MINIMUM_WAGE_CURRENT_AS_OF` ใน `col_00_settings.py` คือวันที่ตรวจแล้วว่าฉบับที่ 14 ยังเป็นฉบับปัจจุบัน ถ้ามีประกาศใหม่ให้เพิ่มแถวในไฟล์ seed แล้วเลื่อนวันที่นี้

## ตาราง PostgreSQL (`localhost:5433`, DB `etl_db`)

| ชั้น | ตาราง |
|---|---|
| Dimension | `dim_area`, `dim_commodity`, `dim_product` |
| Silver | `cpi_monthly` (หลักล้านแถว), `retail_prices_daily`, `minimum_wage`, `farm_prices_monthly`, `etl_load_log` |
| Gold | `cpi_yearly_summary`, `price_estimates`, `real_wage_monthly`, `farm_retail_correlation` |
| ML | `cpi_model_metrics`, `cpi_forecasts` |

## ตรวจสอบ

```bash
docker compose run --rm airflow-cli dags list-import-errors
```

```bash
docker exec postgres_target psql -U etluser -d etl_db -c "SELECT COUNT(*) FROM cpi_monthly;"
```

```bash
curl http://localhost:8001/health
```

รัน unit test ใน container ของ Airflow (ต้องติดตั้ง pytest ครั้งแรกด้วย `docker exec airflow_scheduler python -m pip install pytest`):

```bash
docker cp tests airflow_scheduler:/tmp/tests && docker exec airflow_scheduler python -m pytest -q /tmp/tests
```

## ข้อจำกัด

- API ของ สนค. ตอบทีละ request (ยิงขนานหลาย task ไม่ได้เร็วขึ้นมาก) backfill ครั้งแรกจึงใช้เวลานาน แต่รอบถัดไปใช้ cache
- API ราคาของกรมการค้าภายในล่มบ่อย จึงใช้ web scraping เป็นแหล่งหลัก ถ้ากรมเปลี่ยนโครงสร้างหน้าเว็บ ตัวอ่านตารางต้องแก้ตาม (มี unit test ใน `tests/test_scrape.py` ช่วยตรวจ)
- ราคาของกรมการค้าภายในเป็นราคาตลาดในกรุงเทพฯ ไม่ใช่ราคาทุกจังหวัด
- ห้ามรัน `airflow tasks test` ของ DAG เดียวกันหลายตัวพร้อมกันด้วยวันที่เดียวกัน เพราะแต่ละตัวสร้าง DAG run ชั่วคราวที่ key ซ้ำกัน (การรันจริงผ่าน scheduler ไม่มีปัญหานี้)
- ดัชนีรายจังหวัดเทียบ "อัตราการเปลี่ยนแปลง" ข้ามจังหวัดได้ แต่เทียบ "ระดับราคา" ข้ามจังหวัดไม่ได้ เพราะทุกจังหวัดตั้งปี 2566 = 100
- ความสัมพันธ์ราคาหน้าฟาร์มกับราคาขายปลีกเป็น correlation ไม่ได้ยืนยันเหตุและผล
- ผลพยากรณ์ใช้เพื่อการศึกษา ไม่ใช่คำแนะนำทางเศรษฐกิจหรือการเงิน
- รหัสผ่านใน Compose ใช้สำหรับ development เท่านั้น
