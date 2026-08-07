"use client";

import { ChangeEvent, DragEvent, MouseEvent, useEffect, useRef, useState } from "react";

type Backdrop = "studio" | "warm" | "graphite";
type Ratio = "original" | "16:9" | "4:3" | "1:1";

const backdropNames: Record<Backdrop, string> = {
  studio: "화이트 스튜디오",
  warm: "웜그레이 쇼룸",
  graphite: "그래파이트 스튜디오",
};

const ratioValues: Record<Ratio, number | null> = {
  original: null,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
};

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, r);
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState("/sample-car.jpg");
  const [sourceName, setSourceName] = useState("RTC20250929100024473_0X.jpg");
  const [foregroundUrl, setForegroundUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<Backdrop>("studio");
  const [ratio, setRatio] = useState<Ratio>("16:9");
  const [platePoint, setPlatePoint] = useState<{ x: number; y: number } | null>(null);
  const [plateMode, setPlateMode] = useState(false);
  const [compare, setCompare] = useState(50);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
      if (foregroundUrl) URL.revokeObjectURL(foregroundUrl);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [sourceUrl, foregroundUrl, resultUrl]);

  useEffect(() => {
    if (!foregroundUrl) return;
    void composeResult(foregroundUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foregroundUrl, backdrop, ratio, platePoint]);

  async function composeResult(foreground: string) {
    const image = await loadImage(foreground);
    const targetRatio = ratioValues[ratio] ?? image.width / image.height;
    const maxSide = 1800;
    let width = image.width;
    let height = Math.round(width / targetRatio);

    if (height > image.height) {
      height = image.height;
      width = Math.round(height * targetRatio);
    }
    const scaleDown = Math.min(1, maxSide / Math.max(width, height));
    width = Math.round(width * scaleDown);
    height = Math.round(height * scaleDown);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;

    const palettes = {
      studio: ["#fbfbfa", "#e7e8e6", "#cfd2cf"],
      warm: ["#f3eee7", "#d7cec2", "#b8aea3"],
      graphite: ["#3b3d40", "#1e2023", "#101113"],
    } as const;
    const [top, middle, bottom] = palettes[backdrop];
    const wall = context.createLinearGradient(0, 0, 0, height);
    wall.addColorStop(0, top);
    wall.addColorStop(0.68, middle);
    wall.addColorStop(1, bottom);
    context.fillStyle = wall;
    context.fillRect(0, 0, width, height);

    const glow = context.createRadialGradient(width * 0.5, height * 0.44, 0, width * 0.5, height * 0.44, width * 0.58);
    glow.addColorStop(0, backdrop === "graphite" ? "rgba(255,255,255,.17)" : "rgba(255,255,255,.9)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);

    context.save();
    context.filter = "blur(18px)";
    context.fillStyle = backdrop === "graphite" ? "rgba(0,0,0,.65)" : "rgba(30,35,38,.26)";
    context.beginPath();
    context.ellipse(width * 0.52, height * 0.82, width * 0.34, height * 0.075, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();

    const sourceRatio = image.width / image.height;
    const drawRatio = targetRatio;
    let drawWidth = width;
    let drawHeight = drawWidth / sourceRatio;
    if (drawHeight > height) {
      drawHeight = height;
      drawWidth = drawHeight * sourceRatio;
    }
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;
    context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

    if (platePoint) {
      const px = platePoint.x * width;
      const py = platePoint.y * height;
      const plateWidth = width * 0.15;
      const plateHeight = Math.max(28, height * 0.055);
      const gradient = context.createLinearGradient(px - plateWidth / 2, 0, px + plateWidth / 2, 0);
      gradient.addColorStop(0, "#17191b");
      gradient.addColorStop(0.5, "#2e3135");
      gradient.addColorStop(1, "#17191b");
      context.fillStyle = gradient;
      roundedRect(context, px - plateWidth / 2, py - plateHeight / 2, plateWidth, plateHeight, plateHeight * 0.16);
      context.fill();
      context.fillStyle = "rgba(255,255,255,.78)";
      context.font = `600 ${Math.max(12, plateHeight * 0.28)}px Arial`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("CAR STUDIO", px, py);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    if (!blob) return;
    const nextUrl = URL.createObjectURL(blob);
    setResultUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return nextUrl;
    });
  }

  function acceptFile(file?: File) {
    if (!file || !file.type.startsWith("image/")) return;
    const next = URL.createObjectURL(file);
    setSourceUrl((old) => {
      if (old.startsWith("blob:")) URL.revokeObjectURL(old);
      return next;
    });
    setSourceName(file.name);
    setForegroundUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setResultUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setPlatePoint(null);
    setStatus("idle");
    setProgress(0);
    setError("");
  }

  async function runAi() {
    setStatus("working");
    setError("");
    setProgress(4);
    try {
      const response = await fetch(sourceUrl);
      const sourceBlob = await response.blob();
      const { removeBackground } = await import("@imgly/background-removal");
      const cutout = await removeBackground(sourceBlob, {
        publicPath: `${window.location.origin}/api/ai-assets/`,
        model: "isnet_quint8",
        device: "cpu",
        proxyToWorker: false,
        fetchArgs: { cache: "force-cache" },
        output: { format: "image/png", quality: 1, type: "foreground" },
        progress: (_key: string, current: number, total: number) => {
          if (total > 0) setProgress(Math.max(6, Math.min(92, Math.round((current / total) * 92))));
        },
      });
      const nextUrl = URL.createObjectURL(cutout);
      setForegroundUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return nextUrl;
      });
      setProgress(100);
      setStatus("done");
    } catch (cause) {
      console.error(cause);
      setStatus("error");
      const detail = cause instanceof Error ? cause.message : "알 수 없는 오류";
      setError(`AI 모델을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. (${detail})`);
    }
  }

  function placePlate(event: MouseEvent<HTMLDivElement>) {
    if (!plateMode || !resultUrl) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setPlatePoint({
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    });
    setPlateMode(false);
  }

  function downloadResult() {
    if (!resultUrl) return;
    const link = document.createElement("a");
    link.href = resultUrl;
    link.download = `${sourceName.replace(/\.[^.]+$/, "")}-studio.jpg`;
    link.click();
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="카 스튜디오 홈">
          <span className="brand-mark">C</span>
          <span>CAR STUDIO <small>AI</small></span>
        </a>
        <div className="header-note"><i /> 사진은 기기 안에서 안전하게 처리됩니다</div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">AI VEHICLE IMAGING</p>
          <h1>찍은 그대로 올리고,<br /><em>전시장 사진처럼.</em></h1>
        </div>
        <p className="hero-copy">복잡한 야외 배경을 지우고 차량에 어울리는 빛과 공간을 더합니다. 별도 설치 없이 브라우저에서 바로 완성하세요.</p>
      </section>

      <section className="workspace" onDragOver={(event: DragEvent) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); acceptFile(event.dataTransfer.files[0]); }}>
        <aside className="controls">
          <div className="step-heading"><span>01</span><div><h2>차량 사진</h2><p>JPG, PNG · 최대 20MB 권장</p></div></div>
          <button className="upload-card" onClick={() => inputRef.current?.click()}>
            <span className="upload-icon">＋</span>
            <strong>사진 바꾸기</strong>
            <span>클릭하거나 파일을 끌어오세요</span>
          </button>
          <input ref={inputRef} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])} />
          <div className="file-row"><span className="file-thumb"><img src={sourceUrl} alt="선택한 차량" /></span><span><strong>{sourceName}</strong><small>원본 이미지 준비됨</small></span><b>✓</b></div>

          <div className="divider" />
          <div className="step-heading"><span>02</span><div><h2>스튜디오 설정</h2><p>배경과 결과 비율을 선택하세요</p></div></div>
          <label className="label">배경 스타일</label>
          <div className="backdrops">
            {(Object.keys(backdropNames) as Backdrop[]).map((key) => (
              <button key={key} className={backdrop === key ? "active" : ""} onClick={() => setBackdrop(key)}>
                <i className={`swatch ${key}`} />
                <span>{backdropNames[key]}</span>
              </button>
            ))}
          </div>
          <label className="label">이미지 비율</label>
          <div className="segments">
            {(Object.keys(ratioValues) as Ratio[]).map((key) => <button key={key} className={ratio === key ? "active" : ""} onClick={() => setRatio(key)}>{key === "original" ? "원본" : key}</button>)}
          </div>
          <button className={`plate-button ${plateMode ? "active" : ""}`} disabled={!resultUrl} onClick={() => setPlateMode((value) => !value)}>
            <span>▰</span><span><strong>번호판 보호</strong><small>{platePoint ? "위치 지정됨 · 다시 누르면 재설정" : "누른 뒤 이미지의 번호판을 선택"}</small></span>
          </button>
          {platePoint && <button className="text-button" onClick={() => setPlatePoint(null)}>번호판 가림 해제</button>}

          <button className="primary" disabled={status === "working"} onClick={runAi}>
            {status === "working" ? "AI가 차량을 분리하는 중…" : resultUrl ? "AI 다시 변환하기" : "AI 스튜디오 변환"}
            <span>→</span>
          </button>
          {status === "working" && <div className="progress"><i style={{ width: `${progress}%` }} /><span>첫 실행은 AI 모델 준비로 조금 더 걸릴 수 있어요 · {progress}%</span></div>}
          {error && <p className="error">{error}</p>}
        </aside>

        <div className="stage-panel">
          <div className="stage-top">
            <div><span className="status-dot" />{resultUrl ? "변환 완료" : "원본 준비됨"}</div>
            {resultUrl && <button className="download" onClick={downloadResult}>↓ 결과 저장</button>}
          </div>
          <div className={`image-stage ${plateMode ? "targeting" : ""}`} onClick={placePlate}>
            <img className="result-image" src={resultUrl ?? sourceUrl} alt={resultUrl ? "AI 스튜디오 변환 결과" : "변환 전 차량 원본"} />
            {resultUrl && <div className="original-layer" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}><img src={sourceUrl} alt="변환 전 원본 비교" /></div>}
            {resultUrl && <div className="compare-line" style={{ left: `${compare}%` }}><i>↔</i></div>}
            {!resultUrl && status !== "working" && <div className="ready-badge"><b>READY</b><span>왼쪽 설정을 확인하고<br />AI 변환을 시작하세요</span></div>}
            {status === "working" && <div className="processing-overlay"><div className="scanner" /><strong>차량 윤곽을 찾고 있습니다</strong><span>창문, 휠, 그림자를 섬세하게 분리하는 중</span></div>}
            {plateMode && <div className="plate-hint">번호판 중앙을 클릭하세요</div>}
          </div>
          {resultUrl && <div className="compare-control"><span>원본</span><input aria-label="원본과 결과 비교" type="range" min="0" max="100" value={compare} onChange={(event) => setCompare(Number(event.target.value))} /><span>AI 결과</span></div>}
          <div className="stage-footer"><span>원본 차량의 형태와 색상은 유지됩니다</span><span>{ratio === "original" ? "원본 비율" : ratio} · 고화질 JPG</span></div>
        </div>
      </section>

      <section className="how-it-works">
        <p className="eyebrow">HOW IT WORKS</p>
        <h2>차량은 그대로, 주변만 정돈합니다.</h2>
        <div className="feature-grid">
          <article><b>01</b><h3>기기 내 AI 분리</h3><p>사진을 외부 서버에 올리지 않고 브라우저에서 차량과 배경을 구분합니다.</p></article>
          <article><b>02</b><h3>자연스러운 스튜디오</h3><p>바닥 그림자와 주변광을 더해 잘라 붙인 느낌 없이 안정적인 결과를 만듭니다.</p></article>
          <article><b>03</b><h3>바로 판매용으로</h3><p>비율과 번호판 보호를 적용해 중고차 상세페이지용 JPG로 저장합니다.</p></article>
        </div>
      </section>

      <footer><span>CAR STUDIO AI</span><p>AI 결과는 원본 상태 확인을 대체하지 않습니다. 판매 시 실제 차량 상태를 함께 고지하세요.</p></footer>
    </main>
  );
}
