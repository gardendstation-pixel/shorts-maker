FROM python:3.11-slim

# 시스템 패키지 설치 (ffmpeg, libgomp1 for ctranslate2)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libgomp1 \
    git \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 의존성 먼저 설치 (캐시 레이어 최적화)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 소스 코드 복사
COPY . .

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
