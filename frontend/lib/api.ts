const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "1",
};

export interface TopicSuggestion {
  title: string;
  description: string;
  ranges: Array<{ start: number; end: number }>;
  duration_sec: number;
  recommended?: boolean;
  recommend_reason?: string;
}

export interface SubTopic {
  title: string;
  description: string;
  ranges: Array<{ start: number; end: number }>;
  duration_sec: number;
}

export interface ShortOutput {
  index: number;
  title: string;
  path: string;
  duration_sec: number;
  youtube_url: string;
}

export interface JobStatus {
  job_id: string;
  status: "pending" | "processing" | "suggested" | "generating" | "done" | "error";
  progress: number;
  message: string;
  title?: string;
  duration?: number;
  summary?: string;
  keywords?: string[];
  suggestions?: TopicSuggestion[];
  segments?: Array<{ start: number; end: number }>;
  download_url?: string;
  outputs?: ShortOutput[];
  error?: string;
}

export async function createJob(url: string): Promise<{ job_id: string }> {
  const res = await fetch(`${BASE_URL}/api/jobs`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error("작업 생성 실패");
  return res.json();
}

export async function generateShorts(jobId: string, topicIndex: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/generate`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ topic_index: topicIndex }),
  });
  if (!res.ok) throw new Error("쇼츠 생성 요청 실패");
}

export async function generateCustomShorts(jobId: string, topic: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/generate-custom`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ topic }),
  });
  if (!res.ok) throw new Error("쇼츠 생성 요청 실패");
}

export async function subdivideTopic(
  jobId: string,
  title: string,
  ranges: Array<{ start: number; end: number }>,
): Promise<{ sub_topics: SubTopic[] }> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/subdivide`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ title, ranges }),
  });
  if (!res.ok) throw new Error("세분화 요청 실패");
  return res.json();
}

export async function generateShortsFromSegments(
  jobId: string,
  title: string,
  ranges: Array<{ start: number; end: number }>,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/generate-segments`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ title, ranges }),
  });
  if (!res.ok) throw new Error("쇼츠 생성 요청 실패");
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}`, {
    headers: { "ngrok-skip-browser-warning": "1" },
  });
  if (!res.ok) throw new Error("상태 조회 실패");
  return res.json();
}

export function getDownloadUrl(jobId: string): string {
  return `${BASE_URL}/api/jobs/${jobId}/download`;
}

export function getVideoUrl(jobId: string): string {
  return `${BASE_URL}/api/jobs/${jobId}/video`;
}

export async function generateAllShorts(jobId: string): Promise<{ total: number }> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/generate-all`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
  });
  if (!res.ok) throw new Error("전체 생성 요청 실패");
  return res.json();
}

export function getShortDownloadUrl(jobId: string, index: number): string {
  return `${BASE_URL}/api/jobs/${jobId}/download/${index}`;
}

export async function uploadToYouTube(
  jobId: string,
  index: number,
  title: string,
  description: string,
  privacy: string,
): Promise<{ youtube_url: string }> {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/upload-youtube/${index}`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ title, description, privacy }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "업로드 실패");
  }
  return res.json();
}

export async function getYouTubeAuthUrl(): Promise<{ url: string }> {
  const res = await fetch(`${BASE_URL}/api/youtube/auth-url`, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "YouTube 인증 URL 조회 실패");
  }
  return res.json();
}

export async function getYouTubeStatus(): Promise<{ configured: boolean; authorized: boolean }> {
  const res = await fetch(`${BASE_URL}/api/youtube/status`, { headers: DEFAULT_HEADERS });
  if (!res.ok) return { configured: false, authorized: false };
  return res.json();
}

export function getPreviewClipUrl(jobId: string, ranges: Array<{ start: number; end: number }>): string {
  const r = ranges.map(({ start, end }) => `${start}:${end}`).join(",");
  return `/api/video-proxy/${jobId}?r=${encodeURIComponent(r)}`;
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (m === 0) return `${sec}초`;
  return `${m}분 ${sec}초`;
}
