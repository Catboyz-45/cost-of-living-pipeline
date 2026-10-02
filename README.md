# ค่าครองชีพไทย (Thai Cost of Living Pipeline)

โปรเจกต์ Apache Airflow ที่ดึง **ดัชนีราคาผู้บริโภคไทยรายจังหวัด หลักล้านแถว** จากแหล่งข้อมูลทางการ เก็บ **ราคาจริงเป็นบาท** ของของกินและน้ำมันรถด้วย web scraping และ SOAP Web Service เทียบกับ **ค่าแรงขั้นต่ำ** และเทรนโมเดล ML พยากรณ์ว่า **เดือนหน้าของแต่ละหมวดในแต่ละจังหวัดจะแพงขึ้นหรือถูกลง** แล้วแสดงผลบนหน้าเว็บ (FastAPI) และส่งออกเป็น CSV สำหรับ Power BI

โปรเจกต์ตอบ 3 คำถาม:

1. **ย้อนหลัง:** ข้าว หมู ไข่ อาหารนอกบ้าน ค่าเช่า น้ำมัน แพงขึ้นเท่าไหร่ ในจังหวัดไหน
2. **พยากรณ์:** เดือนหน้าราคาแต่ละหมวดจะขึ้นหรือลง
3. **กำลังซื้อ:** ค่าแรงขั้นต่ำซื้อของได้น้อยลงแค่ไหน (ค่าแรงที่แท้จริง และค่าแรง 1 วันซื้อไข่ได้กี่ฟอง)

## แหล่งข้อมูล (ข้อมูลจริงจากหน่วยงานรัฐทั้งหมด)

| ข้อมูล | หน่วยงาน | วิธีดึง | ขอบเขต |
|---|---|---|---|
| ดัชนีราคาผู้บริโภค (CPI) ระดับประเทศและ 5 ภาค | สำนักงานนโยบายและยุทธศาสตร์การค้า (สนค.) | [TPSO Open API](https://index.tpso.go.th/document/cpig/post-month) `POST /OpenApi/Cpig/Month` | รายเดือน ตั้งแต่ปี 2519, สูงสุด 194 หมวด |
| CPI ระดับจังหวัด | สนค. | `POST /OpenApi/Cpip/Month` | 76 จังหวัด รายเดือน ตั้งแต่ปี 2541, 106–173 หมวด (ไม่มีกรุงเทพฯ แยกเดี่ยว — API คืนค่าว่างเมื่อขอรหัส 10 จึงใช้ดัชนี "กรุงเทพฯ และปริมณฑล" จาก Cpig แทน รวมครบ 77) |
| ราคาขายปลีกรายวันเป็นบาท (เนื้อสัตว์ ไข่ สัตว์น้ำ ผัก ผลไม้ ของแห้ง น้ำมันพืช ข้าวสาร) | กรมการค้าภายใน | **Web scraping** หน้าค้นหาราคา [MOC Open Data](https://data.moc.go.th/OpenData/GISProductPrice) ด้วย `requests` + BeautifulSoup (สำรองด้วย API `GET /gis-product-prices` ซึ่งล่มบ่อย) | 283 สินค้าขายปลีก รายวัน ตั้งแต่ปี 2558 — รวมกับราคาน้ำมันรถ 534,231 แถว |
| ราคาขายปลีกน้ำมันรถรายวัน (ดีเซล แก๊สโซฮอล์ 95/91/E20) กรุงเทพฯ | ปตท. | Web Service SOAP [`OilPrice.asmx` `GetOilPrice`](https://orapiweb.pttor.com/oilservice/OilPrice.asmx) ทีละวัน + cache รายเดือน | รายวัน ตั้งแต่ 1 ม.ค. 2565 |
| ค่าจ้างขั้นต่ำรายจังหวัด | สำนักงานปลัดกระทรวงแรงงาน / คณะกรรมการค่าจ้าง | data.go.th (CKAN API) + PDF ประกาศฉบับที่ 9, 11–14 | 77 จังหวัด ตั้งแต่ปี 2555 ถึงปัจจุบัน |
| ราคาสินค้าปศุสัตว์ที่เกษตรกรขายได้ | กรมปศุสัตว์ | data.go.th (CKAN API) | รายเดือน 2562–2568 |

ปีฐานของดัชนีคือ 2566 = 100 ทุกไฟล์ใช้ปีฐานเดียวกัน

## สถาปัตยกรรม

```text
 TPSO API ────────┐                         ┌─> dim_area / dim_commodity / dim_product
 เว็บกรมการค้าภายใน ┤  Extract (14 task ขนาน)  │
  (scraping)      ├─> Bronze: data/raw ─────┼─> Silver: cpi_monthly (หลักล้านแถว), retail_prices_daily,
 ปตท. SOAP ───────┤   (JSON.gz ดิบ)         │            minimum_wage, farm_prices_monthly
 data.go.th ──────┘                         │
                        Validate (Branch) ──> data_quality_alert
                                    │
                        Transform (SQL) ──> Gold: cpi_yearly_summary, price_estimates, retail_price_monthly,
                                    │             real_wage_monthly, farm_retail_correlation
                                    │
            Train -> Evaluate -> Champion vs Challenger -> Deploy/Skip -> Smoke test
                                    │
                        Forecast เดือนหน้า -> cpi_forecasts + ทายไว้ vs เกิดจริง -> cpi_backtest
                                    │
                        Export CSV -> exports/ -> Power BI
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
| Parallel tasks จาก loop | Extract 14 task ขนานกันใน `TaskGroup` (ดัชนีจังหวัด 6 ช่วงปี และ scraping 3 กลุ่มสินค้าสร้างจาก loop) | `cost_of_living_backfill.py` |
| `PostgresOperator` / `PostgresHook` | สร้าง schema, COPY + upsert, อ่านข้อมูลเทรน | `col_02`, `col_05`, `col_06` |
| ETL + retry | Session retry/backoff, `retries=2`, circuit breaker สำหรับ API ที่ล่มบ่อย | `col_01`, `col_03` |
| Web scraping | อ่านรายการสินค้าจาก `<select>` แล้วส่งฟอร์มค้นหา (GET) และอ่านตาราง HTML ด้วย BeautifulSoup แบ่ง 3 task ขนานกันตามกลุ่มสินค้า | `col_10_scrape.py` |
| SOAP Web Service | ส่ง XML envelope ไป `GetOilPrice` ของ ปตท. แล้ว parse ผลลัพธ์ที่ escape ซ้อนอยู่ | `col_11_fuel.py` |
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
├── col_11_fuel.py             # ราคาน้ำมันรถจริงจาก Web Service ของ ปตท. (SOAP)
├── cost_of_living_backfill.py # DAG: thai_cost_of_living_backfill
└── cost_of_living_monthly.py  # DAG: thai_cost_of_living_monthly
model_service/
├── main.py                    # FastAPI: API ของ dashboard + /api/predict
└── static/                    # Dashboard (HTML/CSS/JS ล้วน) + ขอบเขตจังหวัด GeoJSON
    └── products/              # รูปสินค้า 78 รูปจาก Wikimedia Commons + เครดิต (CREDITS.md, credits.html)
data/seed/minimum_wage_extra.csv  # ค่าแรงขั้นต่ำฉบับที่ 9, 11–14 ที่แปลงจาก PDF
scripts/build_minimum_wage_seed.py # สคริปต์แปลง PDF ประกาศค่าแรง -> CSV (ตรวจครบ 77 จังหวัด)
docs/powerbi_guide.md          # วิธีทำ Dashboard
tests/test_features.py         # Unit test: feature engineering
tests/test_scrape.py           # Unit test: ตัวอ่าน HTML ของ web scraping
tests/test_fuel.py             # Unit test: ตัวอ่านผลลัพธ์ SOAP ราคาน้ำมัน
scripts/check_demo.sh          # เช็กความพร้อมก่อนโชว์สด (คอนเทนเนอร์ ข้อมูล โมเดล หน้าเว็บ)
scripts/restore_snapshot.sh    # โหลดข้อมูลสำเร็จรูป (ฐานข้อมูล + โมเดล) จาก GitHub Release แทนการรัน backfill
scripts/create_snapshot.sh     # สร้างไฟล์ snapshot ใหม่สำหรับแนบใน Release
DESIGN.md                      # แนวดีไซน์ "ใบเสร็จตลาด" (สี ฟอนต์ กฎการใช้สี)
```

`.airflowignore` ทำให้ Airflow ไม่ต้อง parse ไฟล์ `col_XX_*.py` เพราะเป็นโมดูลช่วยงาน ไม่ใช่ DAG

## ลำดับ Task

```text
check_environment -> create_tables
        |
  extract (TaskGroup, รันขนาน)
  ├─ cpi_national_regions           (สนค. ประเทศ + ภาค)
  ├─ cpi_provinces_2541_2545 ... _latest   (สนค. จังหวัด 6 ช่วงปี)
  ├─ retail_prices                  (API กรมการค้าภายใน, soft-fail)
  │    └─> scrape_prices_meat_seafood / _vegetables_fruit / _pantry_rice
  │                                 (web scraping 3 กลุ่ม ขนานกัน, soft-fail)
  ├─ fuel_prices                    (ปตท. SOAP, soft-fail)
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
- **ทายไว้ vs เกิดจริง (backtest):** task `generate_forecasts` ให้โมเดลที่ใช้งานจริงทายทุกเดือนหลังวันที่เทรนจบ (ไม่เคยเห็นตอนเทรน) แล้วเก็บคู่ ทายไว้/เกิดจริง ในตาราง `cpi_backtest` หน้าเว็บแปลงเป็นบาท: ราคาที่ทายไว้ = ราคาเฉลี่ยจริงเดือนก่อน × (1 + % ที่ทายของหมวด) แล้ววัดว่าพลาดกี่ % เทียบกับการเดาว่า "ราคาเท่าเดิม"
- **ราคาที่ AI ทายบนเว็บ:** ราคาเฉลี่ยจริงของเดือนล่าสุดที่ สนค. ประกาศดัชนีแล้ว × (1 + % ที่ทายของหมวดสินค้านั้นในกรุงเทพฯ และปริมณฑล) และแสดงคู่กับราคาจริงของเดือนที่ทายที่สำรวจได้แล้ว
- **ความแม่นที่ควรพูดตรง ๆ:** ทายพลาดเฉลี่ยราว ±0.7% ต่อเดือน ทายทิศทางถูกราว 60% และแม่นกว่าเดาว่าเท่าเดิมราว 9% ใช้ดูแนวโน้ม ไม่ใช่ทายราคาเป๊ะ

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

ราคาคาดการณ์เดือนหน้าของสินค้า = ราคาเฉลี่ยจริงของเดือนล่าสุดที่ สนค. ประกาศดัชนีแล้ว × (1 + % ที่โมเดลคาดของหมวดสินค้านั้นในกรุงเทพฯ และปริมณฑล) จึงเป็นค่าประมาณ ส่วนหมวดที่ไม่มีราคาเป็นบาท (ค่าเดินทาง ค่าเล่าเรียน ฯลฯ) แสดงได้เฉพาะเป็น %

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

   ครั้งแรกใช้เวลาหลายนาที เพราะต้องดาวน์โหลด image และติดตั้ง package ของ Python ทุกครั้งที่ container เริ่ม ระหว่างนี้ webserver อาจขึ้นสถานะ `starting`/`unhealthy` สักพัก

   **ทางลัด (แนะนำสำหรับคนที่โคลนไปลองรัน):** โหลดข้อมูลสำเร็จรูปแทนการรัน backfill 2 ชั่วโมง ได้ฐานข้อมูลครบและไฟล์โมเดลใน 1–3 นาที (ดาวน์โหลด ~30 MB จาก [GitHub Release](https://github.com/Catboyz-45/cost-of-living-pipeline/releases/tag/data-2026-10-02)) แล้วข้ามไปข้อ 6 ได้เลย บน Windows ให้รันใน Git Bash หรือ WSL

   ```bash
   bash scripts/restore_snapshot.sh
   ```

3. เปิด Airflow ที่ <http://localhost:8080> บัญชี development คือ `airflow / airflow`
4. Unpause และ Trigger `thai_cost_of_living_backfill` **หนึ่งครั้ง** ครั้งแรกใช้เวลาประมาณ 2 ชั่วโมง ขึ้นกับความเร็ว API ของ สนค. และเว็บกรมการค้าภายใน (ข้ามข้อนี้ได้ถ้าใช้ทางลัดด้านบน)
5. หลังรันเสร็จ Unpause `thai_cost_of_living_monthly` ให้รันเองทุกเดือน
6. เปิด **Dashboard** ที่ <http://localhost:8001> หรือ Swagger <http://localhost:8001/docs>
7. (ทางเลือก) ไฟล์สำหรับ Power BI อยู่ใน `exports/` ดูวิธีทำใน [docs/powerbi_guide.md](docs/powerbi_guide.md)

ไม่ควรรัน DAG backfill และ DAG รายเดือนพร้อมกัน เพราะทั้งสองเขียนตารางและไฟล์โมเดลชุดเดียวกัน

## ถ้าโคลนไปรันแล้วไม่ขึ้น

| อาการ / ข้อความ error | สาเหตุ | วิธีแก้ |
|---|---|---|
| `Cannot connect to the Docker daemon` | Docker Desktop ยังไม่เปิด | เปิด Docker Desktop รอจนขึ้น Running แล้วสั่งใหม่ |
| `Conflict. The container name "/airflow_webserver" (หรือ /postgres_target) is already in use` | ไฟล์นี้ตั้งชื่อ container ตายตัว ถ้าเคยรัน workshop ที่ใช้ชื่อเดียวกัน Docker จะไม่ยอมสร้างซ้ำ | ไปที่โฟลเดอร์ workshop เก่าแล้วสั่ง `docker compose down` หรือดูชื่อด้วย `docker ps -a` แล้วลบตัวที่ชนด้วย `docker rm -f ชื่อ` (ข้อมูลใน volume ของ workshop ยังอยู่) |
| `Bind for 0.0.0.0:8080 failed: port is already allocated` (หรือ 5433, 8001) | มีโปรแกรมหรือ Airflow ตัวอื่นใช้พอร์ตนั้นอยู่ | หยุดตัวที่ใช้พอร์ตอยู่ (`docker ps` ดูว่าเป็นตัวไหน) หรือแก้เลขพอร์ตฝั่งซ้ายใน `docker-compose.yaml` เช่น `"8081:8080"` |
| `airflow-init` เตือนเรื่อง memory/CPU หรือ webserver/scheduler รีสตาร์ตวนไม่หยุด | Docker Desktop ได้ RAM น้อยเกินไป | Docker Desktop → Settings → Resources ให้ RAM อย่างน้อย 4 GB (แนะนำ 6–8 GB), CPU 2 คอร์, ดิสก์ว่าง 10 GB |
| `service "airflow-init" didn't complete successfully` | init ล้มเหลว | ดูสาเหตุด้วย `docker compose logs airflow-init` ส่วนใหญ่เป็นเรื่อง RAM หรือสิทธิ์โฟลเดอร์ บน Linux ให้ตั้ง `AIRFLOW_UID` ใน `.env` เป็นผลของ `id -u` |
| บน Windows: `invalid user`, `\r: command not found`, `bad interpreter` | ไฟล์ถูกแปลงท้ายบรรทัดเป็น CRLF ตอนโคลน | repo มี `.gitattributes` บังคับ LF แล้ว ถ้าโคลนก่อนหน้านี้ให้โคลนใหม่ หรือรัน `git rm --cached -r . && git reset --hard` |
| เว็บ <http://localhost:8001> เปิดได้แต่ขึ้น "โหลดข้อมูลไม่สำเร็จ" / `No deployed model yet` | ฐานข้อมูลยังว่าง ข้อมูลไม่ได้อยู่ใน Git | รัน `bash scripts/restore_snapshot.sh` หรือรัน DAG `thai_cost_of_living_backfill` จนเสร็จ (~2 ชั่วโมง) |
| Airflow ขึ้นช้ามากครั้งแรก | กำลังติดตั้ง package ของ Python ใน container | รอ 3–5 นาที ดูความคืบหน้าด้วย `docker compose logs -f airflow-webserver` |

เช็กทั้งระบบได้ด้วย `bash scripts/check_demo.sh` (บอกวิธีแก้ทุกข้อที่ไม่ผ่าน)

## Dashboard

Dashboard อยู่ใน `model_service/static/` ใช้ HTML/CSS/JavaScript ล้วน (ไม่มี library กราฟภายนอก) อ่านข้อมูลสดจาก PostgreSQL ผ่าน API ของ FastAPI จึงไม่ต้อง export หรือ refresh แบบ Power BI

เว็บแบ่งเป็น 2 ชั้น: 5 หน้าตอบคำถามของคนทั่วไปด้วยภาษาง่าย และ 1 หน้าเบื้องหลังระบบสำหรับอาจารย์/ผู้สนใจด้านเทคนิค
ทุกหน้ามีประโยคสรุปที่สร้างจากข้อมูลอัตโนมัติ ชื่อหมวดของ สนค. แปลงเป็นภาษาคน (เช่น "หมวดพาหนะ การขนส่ง และการสื่อสาร" → "เดินทางและสื่อสาร") และมีปุ่ม i อธิบายคำที่จำเป็นต้องใช้ เช่น เงินเฟ้อ ดัชนีราคา ค่าแรงเมื่อหักของแพง

| หน้า | ตอบคำถาม | แสดงอะไร |
|---|---|---|
| ของแพงขึ้นแค่ไหน | ตอนนี้ของแพงขึ้นเท่าไหร่ | พาดหัว "ของที่ปีก่อนจ่าย 100 บาท วันนี้ต้องจ่าย 102.53 บาท" + แท่งเงินเฟ้อ 12 เดือน, การ์ด AI ทายเดือนหน้า (ไข่ หมู น้ำมันเป็นบาท), ตัวเลขสำคัญ 4 ช่อง (อาหาร พลังงาน น้ำมัน 95 ค่าแรง), **ต้นทุนวัตถุดิบข้าว 1 จาน** (4 เมนู: ใบเสร็จวัตถุดิบ + แท่งเทียบ 10 ปีก่อน → วันนี้ → AI ทาย), **ราคาจริงของกิน** (เริ่มที่ของกินพื้นฐาน 6 อย่าง กดดูทั้งหมด/ค้นหา/กรองกลุ่ม กดการ์ดเพื่อดูกราฟย้อนหลังพร้อมแถบต่ำสุด-สูงสุด), 5 เรื่องที่แพงขึ้นมากสุดและ 3 เรื่องที่ถูกลงมากสุด |
| จังหวัดไหนแพงเร็ว | จังหวัดไหนของแพงขึ้นเร็วสุด | แผนที่ 77 จังหวัด เลือกได้ 10 เรื่อง (รวมทุกอย่าง อาหาร ค่าไฟ น้ำมันรถ ค่ามือถือและเน็ต ค่ายาและค่ารักษา ค่าเช่าบ้าน ฯลฯ) + **ปุ่ม ▶ เล่นแผนที่ย้อนหลัง 5 ปีทีละเดือน** (สเกลสีเดียวทั้งช่วง เทียบข้ามเดือนได้) + ตารางอันดับ + รายละเอียดจังหวัดที่เลือก |
| เดือนหน้าเป็นไง | เดือนหน้าจะแพงขึ้นไหม | **เป็นบาททั้งหน้า** เฉพาะหมวดที่มีราคาจริง (ของกิน + น้ำมันรถ): เลือกหมวด แล้วค้นหาสินค้า → กราฟราคาจริง 24 เดือน + เส้นประราคาที่ AI ทาย, การ์ดราคาที่ AI ทายคู่กับราคาจริงของเดือนนั้นที่สำรวจได้แล้ว, ปุ่มให้ AI ทายใหม่สด ๆ, **AI ทายไว้ vs เกิดขึ้นจริง** (ตัวเลขความแม่น 3 ตัว + กราฟ 12 เดือนที่ AI ไม่เคยเห็น), สินค้าที่คาดว่าจะแพงขึ้น/ถูกลง |
| ค่าแรงพอไหม | ค่าแรงขั้นต่ำตามทันของแพงไหม | ค้นหาจังหวัด → ค่าแรงวันนี้, ค่าแรงเมื่อหักของแพง, ซื้อของได้มากขึ้น/น้อยลงกี่ %, ค่าแรง 1 วันซื้อไข่/หมู/ข้าว/ผักได้เท่าไหร่, กราฟค่าแรง, ตาราง 10 จังหวัดแรก (กดดูครบ 77) |
| ตะกร้าของฉัน | ของที่ฉันซื้อประจำแพงขึ้นเท่าไหร่ | **หน้าร้านแบบแพลตฟอร์มช้อปปิ้ง** ด้วยราคาจริง 237 รายการ: การ์ดสินค้ามีรูปสินค้าจริง ราคาวันนี้ ราคาปีก่อนขีดฆ่า + ป้าย % และป้าย AI คาดเดือนหน้า, ค้นหา/กรองหมวด/เรียง (แนะนำ แพงขึ้นมากสุด ถูกลงมากสุด ราคาต่ำ-สูง), กด "ใส่ตะกร้า" แล้วปรับจำนวน (ไข่ 30 ฟอง น้ำมัน 40 ลิตร) · ตะกร้าอยู่ด้านข้าง (มือถือเป็นแผ่นเลื่อนขึ้นจากล่าง) แสดงราคาวันนี้ ราคาปีก่อน และ AI ทายเดือนหน้า · ปุ่ม "สรุปค่าใช้จ่าย" (ไม่มีการจ่ายเงินจริง) เปิดใบเสร็จพร้อมกราฟยอดตะกร้าย้อนหลัง 5 ปี · ตะกร้าเก็บใน `localStorage` ของเบราว์เซอร์ ไม่ส่งขึ้นเซิร์ฟเวอร์ |
| เบื้องหลังระบบ | ระบบทำงานยังไง | ขั้นตอน Pipeline 5 ขั้น, กราฟดัชนีราคาย้อนหลังหลายปี (5 ปี–ทั้งหมด), จำนวนแถวทุกตาราง, เวลาโหลดล่าสุด, metric ของโมเดล (RMSE/MAE/R²/direction accuracy/baseline/Champion), correlation ราคาหน้าฟาร์ม, แหล่งข้อมูล |

อนิเมชันใช้เล่าเรื่อง ไม่ใช่ตกแต่ง (เขียนเองด้วย CSS/JS โดยยืมไอเดียจาก [React Bits](https://reactbits.dev) เพราะเว็บไม่ได้ใช้ React): พาดหัวนับจาก 100.00 ไป 102.53 บาท, กราฟวาดจากอดีตไปปัจจุบันแล้วเส้นประที่ AI ทายค่อยโผล่, แท่งโตทีละแท่ง, ตัวเลขวิ่งระหว่างกด "ให้ AI ทายใหม่" แล้วหยุดที่ค่าจริง, ป้าย AI มีแสงวิ่งผ่าน และการ์ดเลื่อนขึ้นเมื่อเลื่อนจอมาถึง ทั้งหมดปิดเองถ้าเครื่องตั้งค่า "ลดการเคลื่อนไหว"

ตัวเลือกที่มีหลายรายการ (สินค้า จังหวัด) ใช้รายการแบบค้นหาได้ที่วาดในหน้าเว็บเอง แทน dropdown ของระบบที่แต่งให้เข้าธีมไม่ได้

ใช้ธีมสว่าง "ใบเสร็จตลาด" อย่างเดียว ออกแบบใน Claude Design ก่อนทำเป็นโค้ด (รายละเอียดใน [DESIGN.md](DESIGN.md)): พื้นครีม ส้มอิฐ = แพงขึ้น น้ำเงิน = ถูกลง และทุกอย่างที่ AI ทายเป็นสีม่วง (การ์ดขอบเส้นประ เส้นประในกราฟ) บนมือถือเมนูย้ายไปอยู่ล่างจอแบบแอป รูปสินค้าในหน้าตะกร้าเป็นรูปตัวแทนของแต่ละชนิดสินค้า 78 รูปจาก [Wikimedia Commons](https://commons.wikimedia.org) (CC BY / CC BY-SA / CC0 / Public domain) รายชื่อผู้ถ่ายและใบอนุญาตครบใน [model_service/static/products/CREDITS.md](model_service/static/products/CREDITS.md) และบนเว็บที่ลิงก์ "เครดิตรูปภาพ" สินค้าที่ต่างเกรดหรือต่างร้านใช้รูปเดียวกัน ส่วนเป็ดทั้งตัวกับผักกะเฉดหารูปถ่ายที่ใช้ได้ไม่เจอ จึงวาดเป็นภาพ SVG ขึ้นเอง (สร้างด้วยสคริปต์ Python) ขอบเขตจังหวัดมาจาก [OpenGISData-Thailand](https://github.com/chingchai/OpenGISData-Thailand) (repo ไม่ได้ระบุ license ไว้) ย่อจุดให้เหลือ 278 KB

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
| Silver | `cpi_monthly` (หลักล้านแถว), `retail_prices_daily` (ของกิน + น้ำมันรถ), `minimum_wage`, `farm_prices_monthly`, `etl_load_log` |
| Gold | `cpi_yearly_summary`, `price_estimates`, `retail_price_monthly`, `real_wage_monthly`, `farm_retail_correlation` |
| ML | `cpi_model_metrics`, `cpi_forecasts`, `cpi_backtest` (ทายไว้ vs เกิดจริง) |

## ตรวจสอบ

ก่อนโชว์สด รันสคริปต์นี้คำสั่งเดียว ตรวจคอนเทนเนอร์ Airflow จำนวนแถวในฐานข้อมูล โมเดล และทุก API ของหน้าเว็บ พร้อมบอกวิธีแก้ถ้าไม่ผ่าน:

```bash
bash scripts/check_demo.sh
```

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

### ต้นทุนข้าว 1 จาน

`GET /api/basket/history?ids=P11028,F52002` คืนราคาเฉลี่ยรายเดือนของสินค้าที่เลือก เรียงตามเดือนเดียวกัน (เดือนที่ไม่มีราคาเป็น null) หน้าเว็บคูณจำนวนในตะกร้าเอง และข้ามเดือนที่บางรายการไม่มีราคา

`GET /api/dishes` คิดต้นทุนวัตถุดิบจากราคาจริง × ปริมาณต่อจานที่ตั้งเป็นตัวอย่าง (เช่น กะเพราหมูไข่ดาว: ข้าวสาร 90 ก. หมู 100 ก. ไข่ 1 ฟอง น้ำมัน 30 มล. กระเทียม 10 ก.) หน่วยที่ขายเป็นแพ็ก เช่น ข้าวสาร "บาท/15 กก." ถูกหารเป็นราคาต่อกิโลก่อน ใช้เฉพาะวัตถุดิบที่มีราคาย้อนหลังครบ 10 ปี จึงไม่รวมใบกะเพรา พริกสด และเครื่องปรุง เป็นต้นทุนวัตถุดิบ ไม่ใช่ราคาขายของร้าน

## คำถามที่อาจารย์น่าจะถาม (เรื่อง AI)

**AI ทายอะไร?** ทาย % ที่ราคาของแต่ละหมวดจะเปลี่ยนในเดือนถัดไป ทุกหมวด (190+) ทุกพื้นที่ (ประเทศ 5 ภาค 76 จังหวัด) รวม 13,571 series ต่อเดือน หน้าเว็บแปลง % เป็นบาทด้วยราคาจริงของสินค้า

**แม่นแค่ไหน?** ทดสอบกับ 12 เดือนล่าสุดที่โมเดลไม่เคยเห็น: ทายพลาดเฉลี่ยราว ±0.7% ต่อเดือน, ทายทิศทางขึ้น/ลงถูกราว 60%, RMSE ต่ำกว่าการเดาว่า "ราคาเท่าเดิม" ราว 9% · ราคาของส่วนใหญ่เปลี่ยนเดือนละไม่ถึง 1% การทายให้แม่นกว่าการเดาว่าเท่าเดิมจึงยาก ตัวเลขนี้แปลว่าโมเดลเรียนรู้รูปแบบได้จริง แต่เหมาะกับดูแนวโน้ม ไม่ใช่ทายราคาเป๊ะ

**รู้ได้ไงว่าไม่ได้โกง (ข้อมูลรั่ว)?** แบ่ง holdout ตามเวลา (ไม่สุ่ม) โมเดลเห็นแค่ข้อมูลก่อนเดือนที่ทดสอบ และกราฟ "AI ทายไว้ vs เกิดขึ้นจริง" บนเว็บใช้โมเดลตัวที่ใช้งานจริงทายเดือนหลังวันที่เทรนจบเท่านั้น

**ทำไมเลือก HistGradientBoosting?** ข้อมูล 2.5 ล้านแถวแบบตาราง มี feature แบบหมวดหมู่ (หมวดสินค้า, พื้นที่) ซึ่งโมเดลนี้รองรับในตัว เทรนเร็วบน CPU ใช้ RAM น้อย (float32) เหมาะกับ Airflow worker ในเครื่องเดียว

**ถ้าโมเดลใหม่แย่กว่าเดิมล่ะ?** Champion/Challenger: รอบรายเดือนเทรนโมเดลใหม่ทุกครั้ง แต่ deploy เฉพาะเมื่อชนะทั้ง baseline และโมเดลเดิมบน holdout ชุดเดียวกัน ไม่งั้น BranchPythonOperator จะไปทาง `skip_deployment`

**ทำไมราคาเป็นบาทมีแค่ของกินกับน้ำมัน?** หน่วยงานรัฐเผยแพร่ราคาเป็นบาทเฉพาะสินค้าเกษตร/อาหาร (กรมการค้าภายใน) และน้ำมัน ส่วนเสื้อผ้า ค่าเช่า ค่าเทอม มีเฉพาะดัชนี จึงแสดงเป็น % ในหน้าอื่นแทน ไม่สร้างราคาปลอมขึ้นมา

## ข้อจำกัด

- API ของ สนค. ตอบทีละ request (ยิงขนานหลาย task ไม่ได้เร็วขึ้นมาก) backfill ครั้งแรกจึงใช้เวลานาน แต่รอบถัดไปใช้ cache
- API ราคาของกรมการค้าภายในล่มบ่อย จึงใช้ web scraping เป็นแหล่งหลัก ถ้ากรมเปลี่ยนโครงสร้างหน้าเว็บ ตัวอ่านตารางต้องแก้ตาม (มี unit test ใน `tests/test_scrape.py` ช่วยตรวจ)
- ราคาของกรมการค้าภายในเป็นราคาตลาดในกรุงเทพฯ ไม่ใช่ราคาทุกจังหวัด
- ห้ามรัน `airflow tasks test` ของ DAG เดียวกันหลายตัวพร้อมกันด้วยวันที่เดียวกัน เพราะแต่ละตัวสร้าง DAG run ชั่วคราวที่ key ซ้ำกัน (การรันจริงผ่าน scheduler ไม่มีปัญหานี้)
- ดัชนีรายจังหวัดเทียบ "อัตราการเปลี่ยนแปลง" ข้ามจังหวัดได้ แต่เทียบ "ระดับราคา" ข้ามจังหวัดไม่ได้ เพราะทุกจังหวัดตั้งปี 2566 = 100
- ความสัมพันธ์ราคาหน้าฟาร์มกับราคาขายปลีกเป็น correlation ไม่ได้ยืนยันเหตุและผล
- ผลพยากรณ์ใช้เพื่อการศึกษา ไม่ใช่คำแนะนำทางเศรษฐกิจหรือการเงิน
- รหัสผ่านใน Compose ใช้สำหรับ development เท่านั้น
