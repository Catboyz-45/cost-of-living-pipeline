#!/usr/bin/env bash
# เช็กความพร้อมก่อนโชว์สด: คอนเทนเนอร์, Airflow, ฐานข้อมูล, โมเดล และหน้าเว็บ
# ใช้: bash scripts/check_demo.sh   (รันจากโฟลเดอร์โปรเจกต์ หลัง docker compose up -d)
set -uo pipefail

AIRFLOW_URL="http://localhost:8080"
DASHBOARD_URL="http://localhost:8001"
failures=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "$2"; failures=$((failures + 1)); }
# รัน SQL ในฐานข้อมูลปลายทาง (ใช้ชื่อผู้ใช้/ฐานข้อมูลจาก environment ของคอนเทนเนอร์เอง)
sql() { docker exec postgres_target sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\"" 2>/dev/null; }

echo "1) คอนเทนเนอร์"
for name in airflow_webserver airflow_scheduler airflow_worker airflow_triggerer airflow_redis airflow_metadata_db postgres_target model_api; do
  state=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || echo "missing")
  case "$state" in
    running|running/healthy) ok "$name ($state)" ;;
    *) bad "$name ($state)" "รัน: docker compose up -d แล้วรอ 1-2 นาที" ;;
  esac
done

echo "2) Airflow"
health=$(curl -s -m 10 "$AIRFLOW_URL/health" || true)
if echo "$health" | grep -q '"scheduler": {[^}]*"status": "healthy"'; then ok "Airflow UI และ scheduler ทำงาน ($AIRFLOW_URL)"
else bad "Airflow health ไม่ผ่าน" "รอให้ webserver ขึ้นครบ หรือดู log: docker logs airflow_scheduler --tail 50"; fi
import_errors=$(docker exec airflow_scheduler airflow dags list-import-errors 2>/dev/null | grep -c "\.py" || true)
if [ "${import_errors:-0}" -eq 0 ]; then ok "DAG import ไม่มี error"; else bad "DAG import error $import_errors ไฟล์" "รัน: docker exec airflow_scheduler airflow dags list-import-errors"; fi
for dag in thai_cost_of_living_backfill thai_cost_of_living_monthly; do
  if docker exec airflow_scheduler airflow dags list 2>/dev/null | grep -q "$dag"; then ok "พบ DAG $dag"; else bad "ไม่พบ DAG $dag" "ตรวจโฟลเดอร์ dags/"; fi
done

echo "3) ข้อมูลในฐานข้อมูล"
check_rows() {  # ชื่อตาราง, จำนวนขั้นต่ำ, คำอธิบาย
  rows=$(sql "SELECT COUNT(*) FROM $1" || echo 0)
  if [ "${rows:-0}" -ge "$2" ]; then ok "$3: $(printf "%'d" "$rows") แถว"
  else bad "$3: ${rows:-0} แถว (ต้องมีอย่างน้อย $2)" "ถ้าข้อมูลหาย ต้องรัน DAG thai_cost_of_living_backfill ใหม่ (ประมาณ 2 ชั่วโมง)"; fi
}
check_rows cpi_monthly 1000000 "ดัชนีราคา (cpi_monthly)"
check_rows retail_prices_daily 100000 "ราคาจริงรายวัน (retail_prices_daily)"
check_rows real_wage_monthly 1000 "ค่าแรงที่แท้จริง (real_wage_monthly)"
check_rows cpi_forecasts 1000 "ค่าที่ AI ทาย (cpi_forecasts)"
check_rows cpi_backtest 100 "ผลทดสอบ AI ทายไว้ vs จริง (cpi_backtest)"
latest=$(sql "SELECT MAX(price_date) FROM retail_prices_daily")
[ -n "$latest" ] && ok "ราคาจริงล่าสุดวันที่ $latest" || bad "ไม่พบวันที่ราคาล่าสุด" "รัน task extract.scrape_prices_* ใน Airflow"

echo "4) โมเดลและหน้าเว็บ"
model=$(curl -s -m 10 "$DASHBOARD_URL/health" || true)
if echo "$model" | grep -q '"exists": *true'; then ok "Model API โหลดโมเดลแล้ว"
else bad "Model API ไม่พร้อม: $model" "รัน: docker compose up -d --build model_api"; fi
for path in "/" "/api/dashboard/summary" "/api/prices" "/api/forecast/products" "/api/forecast/product?product_id=P11028" "/api/basket/history?ids=P11028,F52002" "/api/map" "/api/wage?province_code=10" "/api/pipeline"; do
  result=$(curl -s -o /dev/null -m 15 -w "%{http_code} %{time_total}" "$DASHBOARD_URL$path" || echo "000 0")
  code=${result%% *}; seconds=${result##* }
  if [ "$code" = "200" ]; then ok "$path ($code, ${seconds}s)"; else bad "$path ตอบ $code" "ดู log: docker logs model_api --tail 50"; fi
done

echo
if [ "$failures" -eq 0 ]; then
  printf '\033[32mพร้อมโชว์\033[0m เปิด %s (เว็บ) และ %s (Airflow)\n' "$DASHBOARD_URL" "$AIRFLOW_URL"
else
  printf '\033[31mยังไม่พร้อม: มีปัญหา %d ข้อ\033[0m แก้ตามลูกศรด้านบนแล้วรันสคริปต์นี้อีกครั้ง\n' "$failures"
  exit 1
fi
