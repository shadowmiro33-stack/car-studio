const MODEL_ASSET_BASE =
  "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";

export async function GET(
  request: Request,
) {
  const marker = "/api/ai-assets/";
  const pathname = new URL(request.url).pathname;
  const encodedPath = pathname.includes(marker) ? pathname.slice(pathname.indexOf(marker) + marker.length) : "";
  const path = encodedPath.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!path.length) return new Response("Missing asset path", { status: 400 });
  const safeParts = path.filter(
    (part) => part && part !== "." && part !== ".." && !part.includes("\\"),
  );

  if (safeParts.length !== path.length) {
    return new Response("Invalid asset path", { status: 400 });
  }

  const upstreamUrl = new URL(safeParts.map(encodeURIComponent).join("/"), MODEL_ASSET_BASE);
  const upstream = await fetch(upstreamUrl, {
    headers: { Accept: "application/json, application/wasm, application/octet-stream, */*" },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("AI asset unavailable", { status: upstream.status || 502 });
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);

  return new Response(upstream.body, { status: 200, headers });
}
