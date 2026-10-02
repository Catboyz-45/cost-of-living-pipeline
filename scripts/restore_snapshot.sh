#!/usr/bin/env bash
# โหลดข้อมูลสำเร็จรูป (snapshot) เข้าเครื่อง แทนการรัน DAG backfill ประมาณ 2 ชั่วโมง
# ได้ฐานข้อมูลครบ (ดัชนี 3.3 ล้านแถว ราคาจริง ผลพยากรณ์ ผลทดสอบ AI) + ไฟล์โมเดล ให้หน้าเว็บใช้ได้ทันที
#
# ใช้: bash scripts/restore_snapshot.sh            (ดาวน์โหลดจาก GitHub Release อัตโนมัติ)
#      bash scripts/restore_snapshot.sh ไฟล์.tar.gz  (ใช้ไฟล์ที่ดาวน์โหลดไว้แล้ว)
# รันจากโฟลเดอร์โปรเจกต์ หลัง docker compose up -d (ต้องมี container postgres_target ทำงานอยู่)
set -euo pipefail

SNAPSHOT_URL="https://github.com/Catboyz-45/cost-of-living-pipeline/releases/download/data-2026-10-02/cost-of-living-snapshot-2026-10-02.tar.gz"
TARGET_CONTAINER="${TARGET_CONTAINER:-postgres_target}"
source_file="${1:-$SNAPSHOT_URL}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! docker inspect -f '{{.State.Running}}' "$TARGET_CONTAINER" 2>/dev/null | grep -q true; then
  echo "ไม่พบ container $TARGET_CONTAINER ที่ทำงานอยู่ → รัน docker compose up -d ก่อน" >&2
  exit 1
fi

if [[ "$source_file" == http* ]]; then
  echo "1) ดาวน์โหลด snapshot (~30 MB)"
  curl -fL --progress-bar -o "$work/snapshot.tar.gz" "$source_file"
else
  echo "1) ใช้ไฟล์ $source_file"
  cp "$source_file" "$work/snapshot.tar.gz"
fi

echo "2) แตกไฟล์และตรวจ checksum"
tar -xzf "$work/snapshot.tar.gz" -C "$work"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$work" && sha256sum -c SHA256SUMS)
else
  (cd "$work" && shasum -a 256 -c SHA256SUMS)
fi

echo "3) โหลดข้อมูลเข้า PostgreSQL ($TARGET_CONTAINER) — แทนที่ตารางเดิมทั้งหมด ใช้เวลา 1-3 นาที"
docker cp "$work/cost_of_living.dump" "$TARGET_CONTAINER:/tmp/cost_of_living.dump"
docker exec "$TARGET_CONTAINER" sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges /tmp/cost_of_living.dump && rm -f /tmp/cost_of_living.dump'

echo "4) คัดลอกไฟล์โมเดลไปที่ ./models"
mkdir -p models/cost_of_living
cp "$work/models/cost_of_living/current_model.pkl" models/cost_of_living/current_model.pkl

echo "5) ตรวจจำนวนแถว"
docker exec "$TARGET_CONTAINER" sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT '"'"'cpi_monthly'"'"', COUNT(*) FROM cpi_monthly UNION ALL SELECT '"'"'retail_prices_daily'"'"', COUNT(*) FROM retail_prices_daily UNION ALL SELECT '"'"'cpi_forecasts'"'"', COUNT(*) FROM cpi_forecasts"'

if docker inspect model_api >/dev/null 2>&1; then
  docker restart model_api >/dev/null && echo "รีสตาร์ต model_api แล้ว"
fi
echo "เสร็จ เปิด http://localhost:8001 ได้เลย (ถ้าหน้าเว็บยังเป็นแบบเก่าให้กด Ctrl/Cmd+Shift+R)"
