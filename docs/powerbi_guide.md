# คู่มือทำ Dashboard ด้วย Power BI บนเว็บ

Power BI บนเว็บ (app.powerbi.com) ต่อ PostgreSQL ในเครื่องเราโดยตรงไม่ได้ เพราะต้องใช้ on-premises data gateway ซึ่งมีแต่ Windows งานนี้จึงให้ Airflow task `export_powerbi` เขียนไฟล์ CSV ไว้ที่โฟลเดอร์ `exports/` แล้วเราอัปโหลดไฟล์นั้นขึ้น Power BI

ต้องเข้าด้วยอีเมลมหาวิทยาลัย (@ku.th) เพราะ Power BI ไม่รับอีเมลส่วนตัว เช่น Gmail

## 1. ไฟล์ที่ได้จาก Airflow

| ไฟล์ | เนื้อหา | ใช้ทำ |
|---|---|---|
| `dim_area.csv` | พื้นที่: ทั้งประเทศ 5 ภาค และ 76 จังหวัด | ตัวกรองพื้นที่และแผนที่ |
| `dim_commodity.csv` | หมวดสินค้า ระดับ 1–3 | ตัวกรองสินค้า |
| `dim_product.csv` | สินค้าที่มีราคาเป็นบาท | ตัวกรองสินค้า |
| `fact_cpi_region_monthly.csv` | ดัชนีรายเดือนของประเทศและภาค ตั้งแต่ปี 2519 | กราฟแนวโน้มระยะยาว |
| `fact_cpi_province_monthly_recent.csv` | ดัชนีรายจังหวัด 36 เดือนล่าสุด | แผนที่และตารางจังหวัด |
| `fact_cpi_yearly.csv` | ดัชนีเฉลี่ยรายปี และ % เปลี่ยนแปลงจากปีก่อน | เงินเฟ้อรายปีตามหมวด |
| `fact_forecast.csv` | ผลพยากรณ์เดือนหน้า ขึ้น/ลง/ทรงตัว | หน้าพยากรณ์ |
| `fact_price_estimates.csv` | ราคาจริงเป็นบาท และราคาประมาณย้อนหลังจากดัชนี | หน้าราคาเป็นบาท |
| `fact_real_wage.csv` | ค่าแรงขั้นต่ำ, ค่าแรงที่แท้จริง, ไข่ที่ซื้อได้ด้วยค่าแรง 1 วัน | หน้ากำลังซื้อ |
| `fact_farm_prices.csv` / `fact_farm_retail_correlation.csv` | ราคาหน้าฟาร์ม และความสัมพันธ์กับราคาขายปลีก | หน้าต้นทุนจากฟาร์ม |
| `model_metrics.csv` | RMSE, Baseline, ความแม่นทิศทาง ของทุกรอบที่เทรน | หน้าคุณภาพโมเดล |
| `data_volume.csv` | จำนวนแถวของแต่ละตาราง | การ์ดแสดงว่าข้อมูลถึงหลักล้าน |

`manifest.json` บอกจำนวนแถวและขนาดของแต่ละไฟล์จากรอบล่าสุด

## 2. อัปโหลดขึ้น Power BI

ใช้ไฟล์ **`exports/cost_of_living_powerbi_lite.xlsx`** (~10 MB) ฉบับย่อที่เก็บหมวดระดับ 1–2 ดัชนีภาคและรายปีตั้งแต่ 2559 และดัชนีจังหวัด 24 เดือนล่าสุด เพราะ Power BI นำเข้า Excel ได้ไม่เกินราว 30 MB (ไฟล์เต็ม `cost_of_living_powerbi.xlsx` ~39 MB จะขึ้น `ExcelViewWorkbookExceedsMaximiumSize`) ทั้งสองไฟล์รวมทุกตารางข้างบนไว้ แยกเป็นหนึ่ง sheet ต่อหนึ่งตาราง Power BI บนเว็บสร้าง semantic model หนึ่งตัวต่อหนึ่งไฟล์ ถ้าอัปโหลด CSV ทีละไฟล์จะโยง Relationship ข้ามตารางไม่ได้

1. อัปโหลด `cost_of_living_powerbi_lite.xlsx` ขึ้น **OneDrive ของมหาวิทยาลัย** (Power BI ไม่รับไฟล์ Excel ที่อัปโหลดจากเครื่องตรง ๆ แล้ว จะขึ้น "Upload of Excel File Failed")
2. ใน Power BI ไปที่ **My workspace** → **Import → Report, Paginated Report or Workbook** → **OneDrive for Business** แล้วเลือกไฟล์ (ถ้าถาม ให้เลือก **Import** ข้อมูล ไม่ใช่ Upload ตัวไฟล์)
3. Power BI จะสร้าง **semantic model** ชื่อ `cost_of_living_powerbi_lite` ที่มีทุก sheet เป็นตาราง
   (ชื่อ sheet ใน Excel ยาวได้ไม่เกิน 31 ตัวอักษร ตาราง `fact_cpi_province_monthly_recent` จึงชื่อ `fact_cpi_province_monthly_recen`)
4. เปิด semantic model นั้น → **Open data model** เพื่อโยง Relationship ตามข้อ 3
5. กด **Create report** (หรือ **Explore this data** → **Auto-create**) เพื่อเริ่มวางกราฟ

## 3. Relationship (Model view)

| จาก (many) | ไป (one) | คอลัมน์ |
|---|---|---|
| `fact_cpi_region_monthly` | `dim_area` | `area_key` |
| `fact_cpi_province_monthly_recent` | `dim_area` | `area_key` |
| `fact_cpi_yearly` | `dim_area` | `area_key` |
| `fact_forecast` | `dim_area` | `area_key` |
| `fact_real_wage` | `dim_area` | `area_key` |
| ทุกตาราง fact ที่มี `commodity_code` | `dim_commodity` | `commodity_code` |
| `fact_price_estimates` | `dim_product` | `product_id` |

## 4. Measure (DAX) ที่ใช้บ่อย

```DAX
CPI Rows = SUM ( data_volume[row_count] )

Latest Index =
VAR LastDate = MAX ( fact_cpi_region_monthly[period_date] )
RETURN CALCULATE ( AVERAGE ( fact_cpi_region_monthly[index_value] ),
                   fact_cpi_region_monthly[period_date] = LastDate )

Inflation YoY % = AVERAGE ( fact_cpi_region_monthly[change_yoy] )

Forecast Change % = AVERAGE ( fact_forecast[predicted_change_pct] )

Price Change 10Y % =
VAR LastDate = MAX ( fact_price_estimates[period_date] )
VAR NowPrice = CALCULATE ( AVERAGE ( fact_price_estimates[estimated_price] ),
                           fact_price_estimates[period_date] = LastDate )
VAR OldPrice = CALCULATE ( AVERAGE ( fact_price_estimates[estimated_price] ),
                           fact_price_estimates[period_date] = EDATE ( LastDate, -120 ) )
RETURN DIVIDE ( NowPrice - OldPrice, OldPrice ) * 100

Real Wage Change % =
VAR FirstWage = CALCULATE ( AVERAGE ( fact_real_wage[real_wage] ),
                            FIRSTDATE ( fact_real_wage[period_date] ) )
VAR LastWage = CALCULATE ( AVERAGE ( fact_real_wage[real_wage] ),
                           LASTDATE ( fact_real_wage[period_date] ) )
RETURN DIVIDE ( LastWage - FirstWage, FirstWage ) * 100
```

## 5. หน้า Dashboard ที่แนะนำ (ตอบ 3 คำถามของโปรเจกต์)

**หน้า 1: ของแพงขึ้นแค่ไหน (ย้อนหลัง)**
- การ์ด: `CPI Rows` (หลักล้าน), เงินเฟ้อล่าสุด, ราคาอาหารล่าสุด (YoY)
- Line chart: `fact_cpi_region_monthly` แกน X = `period_date`, ค่า = `index_value`, legend = `dim_commodity[commodity_name]` เลือกไข่, เนื้อสัตว์, อาหารนอกบ้าน, ค่าเช่า, น้ำมัน
- Bar chart: `fact_cpi_yearly[yoy_pct]` ของปีล่าสุด แยกตามหมวดระดับ 2
- Slicer: `dim_area[region_name]`, `dim_commodity[commodity_name]`

**หน้า 2: จังหวัดไหนของแพงขึ้นเร็วที่สุด**
- Filled map / Map: Location = `dim_area[area_name]`, Country = `dim_area[country]`, สี = `change_yoy` จาก `fact_cpi_province_monthly_recent`
  (ถ้าแผนที่วางจังหวัดผิดที่ ให้ใช้ Table เรียงตาม `change_yoy` แทน)
- Table: Top 10 จังหวัดที่ดัชนีอาหาร (`10000`) เพิ่มสูงสุด

**หน้า 3: เดือนหน้าจะแพงขึ้นไหม (ML)**
- Table / Matrix: `fact_forecast` แสดงพื้นที่ × หมวด, `predicted_change_pct`, `direction`
- Conditional formatting: ขึ้น = แดง ลง = เขียว
- Line chart จาก `model_metrics.csv`: RMSE เทียบกับ baseline_rmse ของแต่ละรอบ

**หน้า 4: เงินเดือนเรายังพอไหม (กำลังซื้อ)**
- Line chart: `nominal_wage` กับ `real_wage` ตาม `period_date` (เลือกจังหวัดด้วย slicer)
- การ์ด: `Real Wage Change %`
- ตาราง `fact_price_estimates`: ราคาไข่ หมู ไก่ ข้าว เมื่อ 10 ปีก่อนเทียบกับตอนนี้
- `eggs_per_day_wage`: ค่าแรง 1 วันซื้อไข่ไก่เบอร์ 3 ได้กี่ฟอง

## 6. อัปเดตข้อมูลรอบถัดไป

1. DAG `thai_cost_of_living_monthly` รันเองวันที่ 10 ของทุกเดือน (หรือกด Trigger ใน Airflow)
2. task `export_powerbi` เขียนไฟล์ใน `exports/` ใหม่
3. copy ไฟล์ไปไว้ใน OneDrive ทับไฟล์เดิม แล้วกด **Refresh** ที่ semantic model

## 7. แสดงรายงานในหน้า "เบื้องหลังระบบ" ของเว็บ

หน้า "เบื้องหลังระบบ" (http://localhost:8001) มีการ์ด **Dashboard บน Power BI** ที่ฝังรายงานด้วย iframe ตั้งค่าครั้งเดียวดังนี้

1. เปิดรายงานใน Power BI → **File → Embed report** แล้วเลือกแบบใดแบบหนึ่ง
   - **Website or portal**: ลิงก์ `https://app.powerbi.com/reportEmbed?reportId=...` คนดูต้องล็อกอินบัญชี @ku.th ในเบราว์เซอร์นั้น (เหมาะกับเดโมบนเครื่องตัวเอง)
   - **Publish to web (public)**: ลิงก์ `https://app.powerbi.com/view?r=...` ใครก็เปิดได้โดยไม่ต้องล็อกอิน แต่ข้อมูลจะเป็นสาธารณะ และมหาวิทยาลัยอาจปิดตัวเลือกนี้ไว้
2. คัดลอกเฉพาะลิงก์ (ค่าใน `src="..."` ถ้าได้มาเป็นโค้ด iframe) ไปใส่ในไฟล์ `.env`
   ```
   POWERBI_EMBED_URL=https://app.powerbi.com/reportEmbed?reportId=...
   ```
3. รัน `docker compose up -d model_api` ให้ container อ่านค่าใหม่ แล้วรีเฟรชหน้าเว็บ

เว็บรับเฉพาะลิงก์ที่ขึ้นต้นด้วย `https://app.powerbi.com/` ถ้าไม่ได้ใส่ การ์ดจะบอกวิธีตั้งค่าแทน
