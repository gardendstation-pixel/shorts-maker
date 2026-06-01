"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  createJob, generateShorts, generateCustomShorts, generateShortsFromSegments,
  subdivideTopic, getPreviewClipUrl, startAutoGenerate,
  getShortDownloadUrl, getShortWatchUrl, uploadToYouTube, getYouTubeAuthUrl, getYouTubeStatus,
  getJobStatus, getDownloadUrl, formatSeconds,
  type JobStatus, type TopicSuggestion, type SubTopic, type ShortOutput,
} from "@/lib/api";

type Step = "input" | "analyzing" | "select_topic" | "generating" | "done" | "error";

function DurationBadge({ sec }: { sec: number }) {
  const label = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
  const cls =
    sec <= 30 ? "bg-emerald-50 text-emerald-600 border-emerald-200"
    : sec <= 60 ? "bg-amber-50 text-amber-600 border-amber-200"
    : sec <= 120 ? "bg-orange-50 text-orange-600 border-orange-200"
    : "bg-red-50 text-red-600 border-red-200";
  return (
    <span className={`text-xs font-medium shrink-0 px-2.5 py-1 rounded-full border tabular-nums ${cls}`}>
      {label}
    </span>
  );
}

const primaryBtn =
  "w-full py-3 rounded-xl text-sm font-semibold text-white transition-all " +
  "bg-gradient-to-r from-blue-500 to-violet-500 hover:from-blue-600 hover:to-violet-600 " +
  "shadow-md shadow-blue-200 hover:shadow-lg hover:shadow-blue-300 active:scale-[0.99]";

export default function Home() {
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [customTopic, setCustomTopic] = useState("");
  const [submitError, setSubmitError] = useState("");

  type PreviewInfo = { title: string; ranges: Array<{ start: number; end: number }> };
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [videoError, setVideoError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRangeRef = useRef(0);

  const [subdivideIndex, setSubdivideIndex] = useState<number | null>(null);
  const [subTopics, setSubTopics] = useState<SubTopic[] | null>(null);
  const [selectedSubs, setSelectedSubs] = useState<Set<number>>(new Set());
  const [isSubdividing, setIsSubdividing] = useState(false);

  const [autoWatchModal, setAutoWatchModal] = useState<{ index: number; title: string } | null>(null);
  const autoWatchRef = useRef<HTMLVideoElement | null>(null);
  const autoPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [ytAuthorized, setYtAuthorized] = useState(false);
  const [ytConfigured, setYtConfigured] = useState(false);
  const [ytPopup, setYtPopup] = useState<Window | null>(null);
  const [uploadModal, setUploadModal] = useState<{ index: number; title: string; description: string; privacy: string } | null>(null);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const [uploadedUrls, setUploadedUrls] = useState<Record<number, string>>({});
  const [uploadError, setUploadError] = useState("");

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    failRef.current = 0;
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    getYouTubeStatus().then(s => { setYtConfigured(s.configured); setYtAuthorized(s.authorized); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ytPopup) return;
    const iv = setInterval(async () => {
      const s = await getYouTubeStatus().catch(() => ({ configured: false, authorized: false }));
      if (s.authorized) {
        setYtAuthorized(true);
        setYtPopup(null);
        clearInterval(iv);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [ytPopup]);


  const startPolling = useCallback((jobId: string, onTerminal: (s: JobStatus) => void) => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const s = await getJobStatus(jobId);
        failRef.current = 0;
        setJob(s);
        if (["suggested", "done", "error"].includes(s.status)) {
          stopPolling();
          onTerminal(s);
        }
      } catch {
        if (++failRef.current >= 10) {
          stopPolling();
          setStep("error");
          setJob(p => p ? { ...p, error: "서버 응답 없음. 백엔드가 실행 중인지 확인하세요." } : null);
        }
      }
    }, 2000);
  }, [stopPolling]);

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError("");
    if (!url.trim()) { setSubmitError("URL을 입력해주세요."); return; }
    try {
      const { job_id } = await createJob(url.trim());
      setJob(await getJobStatus(job_id));
      setStep("analyzing");
      startPolling(job_id, s => {
        if (s.status === "suggested") {
          setStep("select_topic");
          startAutoGenerate(job_id).catch(() => {});
          startAutoPolling(job_id);
        } else if (s.status === "error") setStep("error");
      });
    } catch {
      setSubmitError("서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인하세요 (port 8000).");
    }
  };

  const handleGenerate = async () => {
    if (!job || selectedIndex === null) return;
    try {
      await generateShorts(job.job_id, selectedIndex);
      setJob(await getJobStatus(job.job_id));
      setStep("generating");
      startPolling(job.job_id, s => {
        if (s.status === "done") setStep("done");
        else setStep("error");
      });
    } catch {
      setStep("error");
      setJob(p => p ? { ...p, error: "쇼츠 생성 요청에 실패했습니다." } : null);
    }
  };

  const handleGenerateCustom = async () => {
    if (!job || !customTopic.trim()) return;
    try {
      await generateCustomShorts(job.job_id, customTopic.trim());
      setJob(await getJobStatus(job.job_id));
      setStep("generating");
      startPolling(job.job_id, s => {
        if (s.status === "done") setStep("done");
        else setStep("error");
      });
    } catch {
      setStep("error");
      setJob(p => p ? { ...p, error: "쇼츠 생성 요청에 실패했습니다." } : null);
    }
  };

  const handlePreview = (topic: TopicSuggestion, topicIndex: number) => {
    let ranges: Array<{ start: number; end: number }>;
    if (subdivideIndex === topicIndex && subTopics && selectedSubs.size > 0) {
      ranges = [...selectedSubs].sort((a, b) => a - b).flatMap(i => subTopics[i].ranges);
    } else {
      ranges = topic.ranges;
    }
    if (!ranges || ranges.length === 0) return;
    previewRangeRef.current = 0;
    setVideoError("");
    setPreview({ title: topic.title, ranges });
  };

  const handleSubdivide = async (i: number) => {
    if (!job || !job.suggestions) return;
    if (subdivideIndex === i) {
      setSubdivideIndex(null); setSubTopics(null); setSelectedSubs(new Set());
      return;
    }
    const topic = job.suggestions[i];
    setSubdivideIndex(i); setSubTopics(null); setSelectedSubs(new Set());
    setIsSubdividing(true); setSelectedIndex(null); setCustomTopic("");
    try {
      const result = await subdivideTopic(job.job_id, topic.title, topic.ranges);
      setSubTopics(result.sub_topics);
      setSelectedSubs(new Set(result.sub_topics.map((_, idx) => idx)));
    } catch {
      setSubdivideIndex(null);
    } finally {
      setIsSubdividing(false);
    }
  };

  const toggleSub = (i: number) => {
    setSelectedSubs(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const handleGenerateFromSubs = async () => {
    if (!job || subdivideIndex === null || !subTopics || selectedSubs.size === 0) return;
    const topic = job.suggestions![subdivideIndex];
    const ranges = [...selectedSubs].sort((a, b) => a - b).flatMap(i => subTopics[i].ranges);
    try {
      await generateShortsFromSegments(job.job_id, topic.title, ranges);
      setJob(await getJobStatus(job.job_id));
      setStep("generating");
      startPolling(job.job_id, s => {
        if (s.status === "done") setStep("done");
        else setStep("error");
      });
    } catch {
      setStep("error");
      setJob(p => p ? { ...p, error: "쇼츠 생성 요청에 실패했습니다." } : null);
    }
  };

  const selectedSubDuration = subTopics
    ? [...selectedSubs].reduce((acc, i) => acc + (subTopics[i]?.duration_sec ?? 0), 0)
    : 0;

  const startAutoPolling = useCallback((jobId: string) => {
    if (autoPollingRef.current) clearInterval(autoPollingRef.current);
    autoPollingRef.current = setInterval(async () => {
      try {
        const s = await getJobStatus(jobId);
        setJob(s);
        if (s.auto_status === "done" || s.auto_status === "error") {
          clearInterval(autoPollingRef.current!);
          autoPollingRef.current = null;
        }
      } catch { /* ignore */ }
    }, 2000);
  }, []);

  useEffect(() => () => {
    if (autoPollingRef.current) clearInterval(autoPollingRef.current);
  }, []);

  const handleGenerateAll = async () => {
    if (!job) return;
    try {
      await startAutoGenerate(job.job_id);
      setJob(await getJobStatus(job.job_id));
      setStep("generating");
      startPolling(job.job_id, s => {
        if (s.status === "done") setStep("done");
        else setStep("error");
      });
    } catch {
      setStep("error");
      setJob(p => p ? { ...p, error: "전체 생성 요청에 실패했습니다." } : null);
    }
  };

  const handleConnectYouTube = async () => {
    try {
      const { url } = await getYouTubeAuthUrl();
      const popup = window.open(url, "youtube_auth", "width=500,height=600");
      setYtPopup(popup);
    } catch (e: unknown) {
      alert((e as Error).message || "YouTube 연결 실패");
    }
  };

  const handleUploadYouTube = async () => {
    if (!uploadModal || !job) return;
    setUploadingIdx(uploadModal.index);
    setUploadError("");
    try {
      const { youtube_url } = await uploadToYouTube(
        job.job_id, uploadModal.index,
        uploadModal.title, uploadModal.description, uploadModal.privacy,
      );
      setUploadedUrls(p => ({ ...p, [uploadModal.index]: youtube_url }));
      setUploadModal(null);
    } catch (e: unknown) {
      setUploadError((e as Error).message || "업로드 실패");
    } finally {
      setUploadingIdx(null);
    }
  };

  const handleReset = () => {
    stopPolling();
    setStep("input"); setJob(null); setUrl("");
    setSelectedIndex(null); setCustomTopic(""); setSubmitError("");
    setSubdivideIndex(null); setSubTopics(null); setSelectedSubs(new Set());
    setPreview(null); setUploadedUrls({}); setUploadModal(null); setUploadError("");
    setAutoWatchModal(null);
    if (autoPollingRef.current) { clearInterval(autoPollingRef.current); autoPollingRef.current = null; }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/40 text-slate-900 flex flex-col">

      {/* 자동생성 쇼츠 영상 보기 모달 */}
      {autoWatchModal && job && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(15,23,42,0.5)", backdropFilter: "blur(8px)" }}
          onClick={() => { setAutoWatchModal(null); autoWatchRef.current?.pause(); }}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-hidden border border-slate-100"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-800 truncate pr-4">{autoWatchModal.title}</p>
              <button
                onClick={() => { setAutoWatchModal(null); autoWatchRef.current?.pause(); }}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all shrink-0 text-base"
              >✕</button>
            </div>
            <video
              ref={autoWatchRef}
              src={getShortWatchUrl(job.job_id, autoWatchModal.index)}
              controls
              playsInline
              className="w-full bg-slate-900"
              onLoadedMetadata={() => autoWatchRef.current?.play().catch(() => {})}
            />
            <div className="px-5 py-3 bg-slate-50 flex justify-end">
              <a
                href={getShortDownloadUrl(job.job_id, autoWatchModal.index)}
                download
                className="text-xs px-4 py-2 rounded-lg bg-violet-500 hover:bg-violet-600 text-white font-medium transition-all no-underline"
              >
                ⬇ 다운로드
              </a>
            </div>
          </div>
        </div>
      )}

      {/* YouTube 업로드 모달 */}
      {uploadModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(15,23,42,0.5)", backdropFilter: "blur(8px)" }}
          onClick={() => { setUploadModal(null); setUploadError(""); }}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden border border-slate-100"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-800">YouTube 업로드</p>
              <button
                onClick={() => { setUploadModal(null); setUploadError(""); }}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all text-base"
              >✕</button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">제목</label>
                <input
                  type="text"
                  value={uploadModal.title}
                  onChange={e => setUploadModal(p => p ? { ...p, title: e.target.value } : null)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">설명 (선택)</label>
                <textarea
                  value={uploadModal.description}
                  onChange={e => setUploadModal(p => p ? { ...p, description: e.target.value } : null)}
                  rows={2}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all resize-none"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">공개 설정</label>
                <select
                  value={uploadModal.privacy}
                  onChange={e => setUploadModal(p => p ? { ...p, privacy: e.target.value } : null)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                >
                  <option value="private">비공개</option>
                  <option value="unlisted">링크 공개</option>
                  <option value="public">전체 공개</option>
                </select>
              </div>
              {uploadError && (
                <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{uploadError}</p>
              )}
              <button
                onClick={handleUploadYouTube}
                disabled={uploadingIdx !== null || !uploadModal.title.trim()}
                className="w-full py-3 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:bg-slate-200 disabled:text-slate-400 transition-all"
              >
                {uploadingIdx !== null ? "업로드 중..." : "YouTube에 업로드"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 영상 미리보기 모달 */}
      {preview && job && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(15,23,42,0.5)", backdropFilter: "blur(8px)" }}
          onClick={() => { setPreview(null); videoRef.current?.pause(); }}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-hidden border border-slate-100"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-800 truncate pr-4">{preview.title}</p>
              <button
                onClick={() => { setPreview(null); videoRef.current?.pause(); }}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all shrink-0 text-base"
              >✕</button>
            </div>
            {videoError ? (
              <div className="w-full bg-slate-900 flex flex-col items-center justify-center py-10 gap-2">
                <p className="text-xs text-red-400">영상 로드 실패</p>
                <p className="text-[10px] text-slate-500 px-4 text-center break-all">{videoError}</p>
              </div>
            ) : (
              <video
                ref={videoRef}
                src={job ? getPreviewClipUrl(job.job_id, preview.ranges) : ""}
                controls
                playsInline
                className="w-full bg-slate-900"
                onLoadedMetadata={() => {
                  setVideoError("");
                  if (videoRef.current) {
                    previewRangeRef.current = 0;
                    videoRef.current.currentTime = 0;
                    videoRef.current.play().catch(() => {});
                  }
                }}
                onError={e => {
                  const v = e.currentTarget;
                  const err = v.error;
                  setVideoError(err ? `MediaError ${err.code}: ${err.message || "알 수 없는 오류"}` : "영상을 불러올 수 없습니다");
                }}
              />
            )}
            <div className="px-5 py-3 flex items-center gap-2 bg-slate-50">
              <span className="text-xs text-slate-500">
                {preview.ranges.length > 1
                  ? `${preview.ranges.length}개 구간`
                  : `${formatSeconds(preview.ranges[0].start)} ~ ${formatSeconds(preview.ranges[preview.ranges.length - 1].end)}`}
              </span>
              <span className="text-slate-300">·</span>
              <span className="text-xs text-slate-400 tabular-nums">
                {(() => {
                  const d = Math.round(preview.ranges.reduce((acc, r) => acc + (r.end - r.start), 0));
                  return d >= 60 ? `${Math.floor(d / 60)}분 ${d % 60}초` : `${d}초`;
                })()}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 헤더 */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-slate-100 px-6 py-3.5">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-sm shadow-md shadow-blue-200">
            ✂️
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-800 tracking-tight">Shorts Maker</h1>
            <p className="text-xs text-slate-400">긴 영상에서 원하는 주제만 골라 쇼츠로</p>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-10">
        <div className="w-full max-w-2xl space-y-3">

          {/* URL 입력 */}
          {step === "input" && (
            <div className="space-y-3">
              <div className="bg-white rounded-2xl p-6 space-y-4 border border-slate-100 shadow-sm">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">영상 URL</label>
                  <form onSubmit={handleAnalyze}>
                    <input
                      type="text" value={url} onChange={e => setUrl(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="w-full bg-slate-50 text-slate-900 placeholder-slate-400 border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-blue-400 focus:ring-3 focus:ring-blue-100 transition-all"
                    />
                    <p className="text-xs text-slate-400 mt-1.5">YouTube · Instagram · TikTok 지원</p>
                    {submitError && (
                      <p className="text-sm text-red-500 bg-red-50 border border-red-100 rounded-xl px-4 py-2.5 mt-3">{submitError}</p>
                    )}
                    <button type="submit" className={`${primaryBtn} mt-4`}>
                      영상 분석하기
                    </button>
                  </form>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[["⬇️","다운로드"],["🎙️","음성 전사"],["🤖","주제 추천"],["✂️","쇼츠 편집"]].map(([icon, label]) => (
                  <div key={label} className="flex flex-col items-center gap-2 py-4 rounded-xl bg-white border border-slate-100 shadow-sm">
                    <span className="text-xl">{icon}</span>
                    <p className="text-xs text-slate-500 font-medium">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 분석 중 / 생성 중 */}
          {(step === "analyzing" || step === "generating") && job && (
            <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm space-y-4">
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2.5">
                    <div className="flex gap-1">
                      {[0,1,2].map(i => (
                        <div
                          key={i}
                          className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce"
                          style={{ animationDelay: `${i * 0.15}s` }}
                        />
                      ))}
                    </div>
                    <span className="text-sm font-medium text-slate-700">{job.message || "처리 중..."}</span>
                  </div>
                  <span className="text-xs text-slate-400 tabular-nums font-medium">{job.progress}%</span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${Math.max(4, job.progress)}%`,
                      background: "linear-gradient(90deg, #3b82f6, #8b5cf6)",
                    }}
                  />
                </div>
              </div>
              {job.title && <p className="text-sm text-slate-500 truncate">{job.title}</p>}
              {step === "analyzing" && <p className="text-xs text-slate-400">음성 전사 단계에서 잠깐 기다려주세요</p>}
            </div>
          )}

          {/* 주제 선택 */}
          {step === "select_topic" && job && (
            <div className="space-y-3">
              {/* 영상 정보 */}
              <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-bold text-slate-800 leading-snug">{job.title || "영상"}</p>
                  {job.duration ? (
                    <span className="text-xs text-slate-400 shrink-0 tabular-nums bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full">
                      {formatSeconds(job.duration)}
                    </span>
                  ) : null}
                </div>
                {job.summary && (
                  <p className="text-xs text-slate-500 leading-relaxed">{job.summary}</p>
                )}
                {job.keywords && job.keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {job.keywords.map((kw, i) => (
                      <span key={i} className="text-xs bg-slate-100 text-slate-500 border border-slate-200 px-2.5 py-0.5 rounded-full">
                        {kw}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 자동 생성 쇼츠 영역 */}
              {(job.auto_status || (job.outputs && job.outputs.length > 0)) && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">자동 생성 쇼츠</p>
                    {job.auto_status === "running" && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                        <span className="text-xs text-violet-500">생성 중... {job.auto_progress ?? 0}%</span>
                      </div>
                    )}
                    {job.auto_status === "done" && (
                      <span className="text-xs text-emerald-500">{job.outputs?.length}개 완료</span>
                    )}
                  </div>

                  {/* 생성 중 프로그레스 바 */}
                  {job.auto_status === "running" && (
                    <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${Math.max(4, job.auto_progress ?? 0)}%`,
                          background: "linear-gradient(90deg, #8b5cf6, #ec4899)",
                        }}
                      />
                    </div>
                  )}

                  {/* 완료된 쇼츠 카드들 */}
                  {job.outputs && job.outputs.map((output: ShortOutput) => (
                    <div key={output.index} className="bg-white rounded-2xl p-4 border border-violet-100 shadow-sm space-y-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-slate-800 truncate">{output.title}</span>
                        <DurationBadge sec={output.duration_sec} />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setAutoWatchModal({ index: output.index, title: output.title })}
                          className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-slate-800 hover:border-slate-300 font-medium transition-all"
                        >
                          ▶ 영상 보기
                        </button>
                        <a
                          href={getShortDownloadUrl(job.job_id, output.index)}
                          download
                          className="text-xs px-3 py-1.5 rounded-lg border border-violet-200 bg-violet-50 text-violet-600 hover:bg-violet-100 font-medium transition-all no-underline"
                        >
                          ⬇ 다운로드
                        </a>
                      </div>
                    </div>
                  ))}

                  {/* 아직 생성 중이고 결과 없을 때 플레이스홀더 */}
                  {job.auto_status === "running" && (!job.outputs || job.outputs.length === 0) && (
                    <div className="bg-white rounded-2xl p-4 border border-violet-100 shadow-sm flex items-center gap-3">
                      <div className="w-4 h-4 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin shrink-0" />
                      <p className="text-xs text-slate-500">첫 번째 쇼츠 생성 중...</p>
                    </div>
                  )}
                </div>
              )}

              {/* 주제 목록 */}
              {(!job.suggestions || job.suggestions.length === 0) ? (
                <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm text-center space-y-1">
                  <p className="text-slate-500 text-sm">쇼츠로 만들기 적합한 구간을 찾지 못했습니다.</p>
                  <p className="text-slate-400 text-xs">아래에서 직접 주제를 입력해보세요.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-400 px-1 uppercase tracking-wider">
                    주제 {job.suggestions.length}개
                  </p>
                  {job.suggestions.map((topic: TopicSuggestion, i: number) => {
                    const isSelected = selectedIndex === i;
                    const isExpanded = subdivideIndex === i;
                    return (
                      <div
                        key={i}
                        className={`rounded-2xl border overflow-hidden transition-all duration-200 ${
                          isSelected
                            ? "border-blue-300 bg-blue-50 shadow-md shadow-blue-100"
                            : isExpanded
                            ? "border-slate-200 bg-slate-50 shadow-sm"
                            : "border-slate-100 bg-white shadow-sm hover:shadow-md hover:border-slate-200"
                        }`}
                      >
                        {/* 주제 헤더 */}
                        <div
                          className="px-4 pt-4 pb-2 cursor-pointer"
                          onClick={() => {
                            setSelectedIndex(i); setCustomTopic("");
                            setSubdivideIndex(null); setSubTopics(null); setSelectedSubs(new Set());
                          }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              {isSelected && (
                                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500" />
                              )}
                              <span className="text-sm font-semibold text-slate-800 truncate">{topic.title}</span>
                              {topic.recommended && (
                                <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200">
                                  추천
                                </span>
                              )}
                            </div>
                            <DurationBadge sec={topic.duration_sec} />
                          </div>
                          <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{topic.description}</p>
                          {topic.recommended && topic.recommend_reason && (
                            <p className="text-xs text-amber-500 mt-1.5 flex items-center gap-1">
                              <span>✦</span> {topic.recommend_reason}
                            </p>
                          )}
                        </div>

                        {/* 버튼 행 */}
                        <div className="px-4 pb-3.5 flex gap-2">
                          <button
                            onClick={e => { e.stopPropagation(); handlePreview(topic, i); }}
                            className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-700 hover:border-slate-300 hover:shadow-sm transition-all font-medium"
                          >
                            ▶ 영상 보기
                          </button>
                          {topic.duration_sec > 60 && (
                            <button
                              onClick={e => { e.stopPropagation(); handleSubdivide(i); }}
                              className={`text-xs px-3 py-1.5 rounded-lg border transition-all font-medium ${
                                isExpanded
                                  ? "border-blue-300 bg-blue-50 text-blue-600"
                                  : "border-slate-200 bg-white text-slate-500 hover:text-slate-700 hover:border-slate-300 hover:shadow-sm"
                              }`}
                            >
                              ✂️ 구간 나누기 {isExpanded ? "▲" : "▼"}
                            </button>
                          )}
                        </div>

                        {/* 세분화 패널 */}
                        {isExpanded && (
                          <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/80 space-y-2">
                            {isSubdividing ? (
                              <div className="flex items-center gap-2.5 py-2">
                                <div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-blue-500 rounded-full animate-spin" />
                                <p className="text-xs text-slate-500">구간 분석 중...</p>
                              </div>
                            ) : subTopics && subTopics.length > 0 ? (
                              <>
                                <p className="text-xs font-medium text-slate-500 pb-1">포함할 구간을 선택하세요</p>
                                {subTopics.map((sub, si) => {
                                  const checked = selectedSubs.has(si);
                                  return (
                                    <label
                                      key={si}
                                      className={`flex items-start gap-3 cursor-pointer rounded-xl px-3 py-2.5 border transition-all ${
                                        checked
                                          ? "bg-white border-blue-200 shadow-sm"
                                          : "bg-transparent border-transparent hover:bg-white/60"
                                      }`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => toggleSub(si)}
                                        className="mt-0.5 accent-blue-500 shrink-0 w-3.5 h-3.5"
                                      />
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2">
                                          <span className={`text-xs font-semibold ${checked ? "text-slate-800" : "text-slate-400"}`}>
                                            {sub.title}
                                          </span>
                                          <span className={`text-xs tabular-nums font-medium ${checked ? "text-slate-500" : "text-slate-300"}`}>
                                            {sub.duration_sec >= 60
                                              ? `${Math.floor(sub.duration_sec / 60)}분 ${sub.duration_sec % 60}초`
                                              : `${sub.duration_sec}초`}
                                          </span>
                                        </div>
                                        <p className={`text-xs mt-0.5 ${checked ? "text-slate-500" : "text-slate-400"}`}>
                                          {sub.description}
                                        </p>
                                      </div>
                                    </label>
                                  );
                                })}
                                {selectedSubs.size > 0 && (
                                  <p className="text-xs text-slate-400 pt-1 tabular-nums">
                                    선택 합계&nbsp;&nbsp;
                                    <span className="font-semibold text-slate-600">
                                      {selectedSubDuration >= 60
                                        ? `${Math.floor(selectedSubDuration / 60)}분 ${selectedSubDuration % 60}초`
                                        : `${selectedSubDuration}초`}
                                    </span>
                                  </p>
                                )}
                              </>
                            ) : (
                              <p className="text-xs text-slate-400 py-1">세분화할 구간이 없습니다.</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 직접 입력 */}
              <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-2.5">
                <div>
                  <p className="text-xs font-semibold text-slate-600">직접 주제 입력</p>
                  <p className="text-xs text-slate-400 mt-0.5">추천 목록에 없는 주제를 직접 요청할 수 있어요</p>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customTopic}
                    onChange={e => {
                      setCustomTopic(e.target.value); setSelectedIndex(null);
                      setSubdivideIndex(null); setSubTopics(null); setSelectedSubs(new Set());
                    }}
                    placeholder="예: 소파 없는 거실 꾸미기 방법"
                    className="flex-1 bg-slate-50 text-slate-900 placeholder-slate-400 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                    onKeyDown={e => { if (e.key === "Enter" && customTopic.trim()) handleGenerateCustom(); }}
                  />
                  <button
                    onClick={handleGenerateCustom}
                    disabled={!customTopic.trim()}
                    className="bg-slate-800 hover:bg-slate-700 disabled:bg-slate-100 disabled:text-slate-400 text-white text-sm font-semibold px-4 rounded-xl border border-transparent transition-all shrink-0 shadow-sm"
                  >
                    만들기
                  </button>
                </div>
              </div>

              {/* 선택 구간으로 만들기 */}
              {subdivideIndex !== null && subTopics && selectedSubs.size > 0 && (
                <button onClick={handleGenerateFromSubs} className={primaryBtn}>
                  선택 구간으로 쇼츠 만들기
                  <span className="ml-2 opacity-70 font-normal text-xs">
                    {selectedSubs.size}개 ·&nbsp;
                    {selectedSubDuration >= 60
                      ? `${Math.floor(selectedSubDuration / 60)}분 ${selectedSubDuration % 60}초`
                      : `${selectedSubDuration}초`}
                  </span>
                </button>
              )}

              {/* 전체 주제로 만들기 */}
              {selectedIndex !== null && subdivideIndex === null && (
                <button onClick={handleGenerate} className={primaryBtn}>
                  &ldquo;{job.suggestions![selectedIndex].title}&rdquo; 쇼츠 만들기
                </button>
              )}

              <button
                onClick={handleReset}
                className="w-full text-slate-400 hover:text-slate-600 text-xs py-1.5 transition-colors"
              >
                처음으로
              </button>
            </div>
          )}

          {/* 완료 */}
          {step === "done" && job && (
            <div className="space-y-3">
              {/* 멀티 쇼츠 완료 */}
              {job.outputs && job.outputs.length > 0 ? (
                <>
                  <div className="bg-white rounded-2xl p-5 border border-emerald-100 shadow-sm space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shadow-sm shadow-emerald-200">
                          <span className="text-white text-xs font-bold">✓</span>
                        </div>
                        <span className="text-emerald-600 font-bold text-sm">
                          {job.outputs.length}개 쇼츠 생성 완료
                        </span>
                      </div>
                      {/* YouTube 연결 상태 */}
                      {ytConfigured && (
                        ytAuthorized ? (
                          <span className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full font-medium">
                            ✓ YouTube 연결됨
                          </span>
                        ) : (
                          <button
                            onClick={handleConnectYouTube}
                            className="text-xs text-white bg-red-500 hover:bg-red-600 px-2.5 py-1 rounded-full font-medium transition-all"
                          >
                            YouTube 연결
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* 쇼츠 목록 */}
                  {job.outputs.map((output: ShortOutput) => {
                    const ytUrl = uploadedUrls[output.index] || output.youtube_url;
                    const isUploading = uploadingIdx === output.index;
                    return (
                      <div key={output.index} className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-semibold text-slate-800 truncate">{output.title}</span>
                          <DurationBadge sec={output.duration_sec} />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <a
                            href={getShortDownloadUrl(job.job_id, output.index)}
                            download
                            className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-slate-800 hover:border-slate-300 font-medium transition-all no-underline"
                          >
                            ⬇ 다운로드
                          </a>
                          {ytUrl ? (
                            <a
                              href={ytUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 font-medium transition-all no-underline"
                            >
                              ▶ YouTube 보기
                            </a>
                          ) : ytConfigured ? (
                            ytAuthorized ? (
                              <button
                                onClick={() => setUploadModal({
                                  index: output.index,
                                  title: output.title,
                                  description: "",
                                  privacy: "private",
                                })}
                                disabled={isUploading}
                                className="text-xs px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 disabled:bg-slate-300 text-white font-medium transition-all"
                              >
                                {isUploading ? "업로드 중..." : "↑ YouTube 업로드"}
                              </button>
                            ) : (
                              <button
                                onClick={handleConnectYouTube}
                                className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-500 hover:bg-red-50 font-medium transition-all"
                              >
                                YouTube 연결 필요
                              </button>
                            )
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                /* 싱글 쇼츠 완료 */
                <div className="bg-white rounded-2xl p-6 border border-emerald-100 shadow-sm space-y-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shadow-sm shadow-emerald-200">
                      <span className="text-white text-xs font-bold">✓</span>
                    </div>
                    <span className="text-emerald-600 font-bold text-sm">쇼츠 생성 완료</span>
                  </div>
                  {job.segments && job.segments.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-400">{job.segments.length}개 클립 · 공백 제거됨</p>
                      <div className="flex flex-wrap gap-1.5">
                        {job.segments.map((seg, i) => (
                          <span
                            key={i}
                            className="text-xs font-mono bg-slate-50 border border-slate-200 text-slate-500 px-2.5 py-1 rounded-lg tabular-nums"
                          >
                            {formatSeconds(seg.start)} → {formatSeconds(seg.end)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <a
                    href={getDownloadUrl(job.job_id)}
                    download
                    className={`flex items-center justify-center gap-2 no-underline ${primaryBtn}`}
                  >
                    <span>⬇</span> MP4 다운로드
                  </a>
                </div>
              )}
              <button
                onClick={handleReset}
                className="w-full text-slate-400 hover:text-slate-600 text-sm py-2 transition-colors"
              >
                새로 만들기
              </button>
            </div>
          )}

          {/* 오류 */}
          {step === "error" && (
            <div className="space-y-3">
              <div className="bg-white rounded-2xl p-6 border border-red-100 shadow-sm space-y-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center shadow-sm shadow-red-200">
                    <span className="text-white text-xs font-bold">✕</span>
                  </div>
                  <span className="text-red-500 font-bold text-sm">오류 발생</span>
                </div>
                <p className="text-sm text-slate-600 whitespace-pre-wrap break-words leading-relaxed">
                  {job?.error || "알 수 없는 오류가 발생했습니다."}
                </p>
              </div>
              <button
                onClick={handleReset}
                className="w-full text-slate-400 hover:text-slate-600 text-sm py-2 transition-colors"
              >
                다시 시도
              </button>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
