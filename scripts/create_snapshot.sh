#!/usr/bin/env bash
# สร้างไฟล์ snapshot (ฐานข้อมูล + โมเดล) สำหรับแนบใน GitHub Release ให้คนที่โคลนไปใช้ restore_snapshot.sh
# ใช้: bash scripts/create_snapshot.sh   (รันจากโฟลเดอร์โปรเจกต์ หลัง backfill เสร็จแล้ว)
set -euo pipefail

stamp="$(date +%Y-%m-%d)"
output="cost-of-living-snapshot-$stamp.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

docker exec postgres_target sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 9 --no-owner --no-privileges -f /tmp/cost_of_living.dump'
docker cp postgres_target:/tmp/cost_of_living.dump "$work/cost_of_living.dump"
docker exec postgres_target rm -f /tmp/cost_of_living.dump
mkdir -p "$work/models/cost_of_living"
cp models/cost_of_living/current_model.pkl "$work/models/cost_of_living/"
(cd "$work" && shasum -a 256 cost_of_living.dump models/cost_of_living/current_model.pkl > SHA256SUMS)
tar -czf "$output" -C "$work" cost_of_living.dump models SHA256SUMS
echo "สร้าง $output แล้ว ($(du -h "$output" | cut -f1)) → แนบใน GitHub Release แล้วแก้ SNAPSHOT_URL ใน scripts/restore_snapshot.sh"
