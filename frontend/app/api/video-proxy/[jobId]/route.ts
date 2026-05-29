import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const { searchParams } = new URL(request.url);
  const r = searchParams.get("r") || "";

  const query = r ? `?r=${encodeURIComponent(r)}` : "";
  const upstreamUrl = `${backendUrl}/api/jobs/${jobId}/preview-clip${query}`;

  const reqHeaders: HeadersInit = { "ngrok-skip-browser-warning": "1" };
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) reqHeaders["range"] = rangeHeader;

  const upstream = await fetch(upstreamUrl, { headers: reqHeaders });

  if (!upstream.ok) {
    return new Response("Video not found", { status: upstream.status });
  }

  const resHeaders = new Headers();
  resHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "video/mp4");
  resHeaders.set("Accept-Ranges", "bytes");
  resHeaders.set("Cache-Control", "no-cache");

  const cl = upstream.headers.get("Content-Length");
  if (cl) resHeaders.set("Content-Length", cl);
  const cr = upstream.headers.get("Content-Range");
  if (cr) resHeaders.set("Content-Range", cr);

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}
