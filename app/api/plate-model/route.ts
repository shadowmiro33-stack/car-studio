const MODEL_URL = "https://huggingface.co/Topurrra/rtdetr-license-plate-detection-onnx/resolve/aecb24a78e31cea03f59b83156d55dde84f20d94/plate_rtdetr.onnx";

export async function GET() {
  const upstream = await fetch(MODEL_URL, { headers: { Accept: "application/octet-stream" } });
  if (!upstream.ok || !upstream.body) {
    return new Response("Plate AI model unavailable", { status: upstream.status || 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
