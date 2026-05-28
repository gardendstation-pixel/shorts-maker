#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 의존성 체크 ─────────────────────────────────────────────────────────────
check() {
  if ! command -v "$1" &>/dev/null; then
    echo "❌ $1 이(가) 설치되어 있지 않습니다."
    echo "   설치: $2"
    exit 1
  fi
}

check ffmpeg  "brew install ffmpeg"
check yt-dlp  "brew install yt-dlp  또는  pip install yt-dlp"
check python3 "brew install python3"
check node    "brew install node"

# ── .env 확인 ────────────────────────────────────────────────────────────────
if [ ! -f "$DIR/backend/.env" ]; then
  cp "$DIR/backend/.env.example" "$DIR/backend/.env"
  echo ""
  echo "⚠️  backend/.env 파일이 없어 예시 파일을 복사했습니다."
  echo "   ANTHROPIC_API_KEY를 설정한 후 다시 실행하세요:"
  echo "   open $DIR/backend/.env"
  echo ""
  exit 1
fi

if grep -q "sk-ant-\.\.\." "$DIR/backend/.env"; then
  echo "⚠️  backend/.env 에 실제 ANTHROPIC_API_KEY를 입력해주세요."
  exit 1
fi

# ── 백엔드 ────────────────────────────────────────────────────────────────────
echo "🐍 백엔드 가상환경 설정 중..."
cd "$DIR/backend"
if [ ! -d ".venv" ]; then
  python3.13 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt

echo "🚀 백엔드 시작 (port 8000)..."
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# ── 프론트엔드 ────────────────────────────────────────────────────────────────
echo "📦 프론트엔드 의존성 확인 중..."
cd "$DIR/frontend"
if [ ! -d "node_modules" ]; then
  npm install
fi

echo "🌐 프론트엔드 시작 (port 3000)..."
npm run dev &
FRONTEND_PID=$!

# ── 종료 처리 ─────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "종료 중..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

echo ""
echo "✅ 실행 중!"
echo "   브라우저: http://localhost:3000"
echo "   API:      http://localhost:8000"
echo "   종료:     Ctrl+C"
echo ""

wait
