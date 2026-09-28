# ใช้ Python image แบบ slim เพื่อลดขนาด image และกำหนด version ให้แน่นอน
FROM python:3.12-slim

# ไม่สร้าง __pycache__ ใน container และแสดง log ออกมาทันที
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# คำสั่งถัดไปทั้งหมดทำงานภายใต้โฟลเดอร์ /app
WORKDIR /app

# Copy requirements ก่อน เพื่อให้ Docker cache ชั้นติดตั้ง package ได้
# (build context คือ root ของโปรเจกต์ ดู docker-compose.yaml)
COPY model_service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy โค้ดสร้าง Feature ชุดเดียวกับที่ Airflow ใช้ตอน Train และ source ของ API
COPY dags/col_08_features.py .
COPY model_service/main.py .
# หน้า dashboard (HTML/CSS/JS + ขอบเขตจังหวัด GeoJSON)
COPY model_service/static ./static

# สร้างผู้ใช้สิทธิ์ต่ำและไม่รันเว็บด้วย root
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

# ระบุ port ที่ Uvicorn รับ request ภายใน container
EXPOSE 8000

# เริ่ม FastAPI app ชื่อ app ที่ประกาศใน main.py
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
