/**
 * encar-cleanup.ts
 * 엔카 촬영장 브랜딩 감지 및 제거 유틸리티
 *
 * - 번호판 영역 블랭킹 (주변색 인페인팅)
 * - 유리 전광판 엔카 스티커 제거
 * - 유리에 비치는 엔카 텍스트 제거
 */

export type CleanupPoint = { x: number; y: number };

export type CleanupResult = {
  removed: number;
  uncertain: number;
  message: string;
};

/**
 * 번호판 영역을 주변 차체색으로 인페인팅하여 완전히 제거합니다.
 * 4점 좌표 기반으로 번호판 사각형 내부를 채웁니다.
 */
export function blankPlateRegion(
  context: CanvasRenderingContext2D,
  points: CleanupPoint[],
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (points.length !== 4) return;

  // 번호판 영역 주변에서 차체색 샘플링
  const sampleColors = sampleSurroundingColor(context, points, canvasWidth, canvasHeight);

  // 번호판 사각형 마스크 생성
  context.save();
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < 4; i++) {
    context.lineTo(points[i].x, points[i].y);
  }
  context.closePath();
  context.clip();

  // 주변색 그라디언트로 채우기
  const centerX = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const centerY = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  const plateWidth = Math.max(
    Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
    Math.hypot(points[2].x - points[3].x, points[2].y - points[3].y),
  );

  // 좌→우 그라디언트로 자연스럽게 채움
  const gradient = context.createLinearGradient(
    centerX - plateWidth / 2, centerY,
    centerX + plateWidth / 2, centerY,
  );
  gradient.addColorStop(0, sampleColors.left);
  gradient.addColorStop(0.5, sampleColors.center);
  gradient.addColorStop(1, sampleColors.right);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  // 약간의 노이즈 추가로 flat-fill 느낌 완화
  const readX = Math.max(0, Math.floor(centerX - plateWidth));
  const readY = Math.max(0, Math.floor(centerY - plateWidth / 2));
  const readW = Math.min(canvasWidth - readX, Math.ceil(plateWidth * 2));
  const readH = Math.min(canvasHeight - readY, Math.ceil(plateWidth));
  if (readW > 0 && readH > 0) {
    const imageData = context.getImageData(readX, readY, readW, readH);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const noise = (Math.random() - 0.5) * 6;
      pixels[i] = Math.max(0, Math.min(255, pixels[i] + noise));
      pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + noise));
      pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + noise));
    }
    context.putImageData(imageData, readX, readY);
  }

  context.restore();

  // 경계 블러 처리
  blurEdges(context, points, 3);
}

function sampleSurroundingColor(
  context: CanvasRenderingContext2D,
  points: CleanupPoint[],
  width: number,
  height: number,
): { left: string; center: string; right: string } {
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const sampleOffsets = [
    { side: "left", dx: -15, dy: 0 },
    { side: "center", dx: 0, dy: -15 },
    { side: "right", dx: 15, dy: 0 },
  ];

  const results: Record<string, { r: number; g: number; b: number; count: number }> = {
    left: { r: 0, g: 0, b: 0, count: 0 },
    center: { r: 0, g: 0, b: 0, count: 0 },
    right: { r: 0, g: 0, b: 0, count: 0 },
  };

  for (const offset of sampleOffsets) {
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      let refX: number, refY: number;
      if (offset.side === "left") {
        refX = points[0].x * (1 - t) + points[3].x * t;
        refY = points[0].y * (1 - t) + points[3].y * t;
      } else if (offset.side === "right") {
        refX = points[1].x * (1 - t) + points[2].x * t;
        refY = points[1].y * (1 - t) + points[2].y * t;
      } else {
        refX = points[0].x * (1 - t) + points[1].x * t;
        refY = points[0].y * (1 - t) + points[1].y * t;
      }

      const sx = Math.max(0, Math.min(width - 1, Math.round(refX + offset.dx)));
      const sy = Math.max(0, Math.min(height - 1, Math.round(refY + offset.dy)));

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const px = Math.max(0, Math.min(width - 1, sx + dx));
          const py = Math.max(0, Math.min(height - 1, sy + dy));
          const idx = (py * width + px) * 4;
          results[offset.side].r += pixels[idx];
          results[offset.side].g += pixels[idx + 1];
          results[offset.side].b += pixels[idx + 2];
          results[offset.side].count++;
        }
      }
    }
  }

  function toColor(data: { r: number; g: number; b: number; count: number }) {
    if (data.count === 0) return "rgb(128,128,128)";
    return `rgb(${Math.round(data.r / data.count)},${Math.round(data.g / data.count)},${Math.round(data.b / data.count)})`;
  }

  return {
    left: toColor(results.left),
    center: toColor(results.center),
    right: toColor(results.right),
  };
}

function blurEdges(
  context: CanvasRenderingContext2D,
  points: CleanupPoint[],
  radius: number,
): void {
  context.save();
  context.filter = `blur(${radius}px)`;
  context.globalCompositeOperation = "source-atop";
  const expandedPath = expandPolygon(points, radius * 2);
  const innerPath = expandPolygon(points, -1);
  context.beginPath();
  context.moveTo(expandedPath[0].x, expandedPath[0].y);
  for (let i = 1; i < expandedPath.length; i++) {
    context.lineTo(expandedPath[i].x, expandedPath[i].y);
  }
  context.closePath();
  context.moveTo(innerPath[0].x, innerPath[0].y);
  for (let i = innerPath.length - 1; i >= 0; i--) {
    context.lineTo(innerPath[i].x, innerPath[i].y);
  }
  context.closePath();
  context.clip();
  context.drawImage(context.canvas, 0, 0);
  context.restore();
}

function expandPolygon(points: CleanupPoint[], amount: number): CleanupPoint[] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    return {
      x: p.x + (dx / dist) * amount,
      y: p.y + (dy / dist) * amount,
    };
  });
}

/**
 * 원본 이미지의 배경(전경 마스크 밖) 영역에서
 * 엔카 스티커(빨간/파란 로고)를 감지하고 주변색으로 메웁니다.
 */
export function removeDisplayStickers(
  sourceContext: CanvasRenderingContext2D,
  foregroundMask: Uint8ClampedArray,
  width: number,
  height: number,
): CleanupResult {
  const imageData = sourceContext.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  let removed = 0;
  let uncertain = 0;

  const visited = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx]) continue;
      if (foregroundMask[idx * 4 + 3] > 128) continue;

      const offset = idx * 4;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];

      const isEncarRed = r > 160 && r > g * 1.8 && r > b * 1.8 && g < 120 && b < 120;
      const isEncarBlue = b > 120 && b > r * 1.4 && b > g * 1.2 && r < 100;

      if (!isEncarRed && !isEncarBlue) continue;

      const region = floodFillRegion(pixels, foregroundMask, visited, width, height, x, y,
        isEncarRed ? "red" : "blue");

      if (region.pixels.length < 20) continue;

      const regionWidth = region.maxX - region.minX + 1;
      const regionHeight = region.maxY - region.minY + 1;
      const areaRatio = (regionWidth * regionHeight) / (width * height);

      if (areaRatio > 0.15) continue;
      if (areaRatio < 0.00005) continue;

      const bgColor = sampleBackgroundAround(pixels, foregroundMask, width, height, region);
      for (const pixelIdx of region.pixels) {
        const po = pixelIdx * 4;
        const edgeDist = edgeDistance(pixelIdx % width, Math.floor(pixelIdx / width), region);
        const blend = Math.min(1, edgeDist / 3);
        pixels[po] = Math.round(pixels[po] * (1 - blend) + bgColor.r * blend);
        pixels[po + 1] = Math.round(pixels[po + 1] * (1 - blend) + bgColor.g * blend);
        pixels[po + 2] = Math.round(pixels[po + 2] * (1 - blend) + bgColor.b * blend);
      }

      if (region.pixels.length > 100) {
        removed++;
      } else {
        uncertain++;
      }
    }
  }

  sourceContext.putImageData(imageData, 0, 0);
  return {
    removed,
    uncertain,
    message: removed > 0
      ? `전광판 스티커 ${removed}개 제거${uncertain > 0 ? ` · ${uncertain}개 불확실` : ""}`
      : uncertain > 0
        ? `${uncertain}개 불확실한 스티커 패턴 발견`
        : "엔카 스티커를 발견하지 못했습니다",
  };
}

type Region = {
  pixels: number[];
  minX: number; maxX: number;
  minY: number; maxY: number;
};

function floodFillRegion(
  pixels: Uint8ClampedArray,
  foregroundMask: Uint8ClampedArray,
  visited: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  colorType: "red" | "blue",
): Region {
  const startIdx = startY * width + startX;
  const queue = [startIdx];
  visited[startIdx] = 1;
  const region: Region = { pixels: [], minX: startX, maxX: startX, minY: startY, maxY: startY };
  let cursor = 0;

  while (cursor < queue.length && queue.length < 50000) {
    const idx = queue[cursor++];
    const px = idx % width;
    const py = Math.floor(idx / width);
    region.pixels.push(idx);
    region.minX = Math.min(region.minX, px);
    region.maxX = Math.max(region.maxX, px);
    region.minY = Math.min(region.minY, py);
    region.maxY = Math.max(region.maxY, py);

    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      if (foregroundMask[nIdx * 4 + 3] > 128) continue;

      const no = nIdx * 4;
      const r = pixels[no], g = pixels[no + 1], b = pixels[no + 2];
      let matches = false;
      if (colorType === "red") {
        matches = r > 120 && r > g * 1.4 && r > b * 1.4;
      } else {
        matches = b > 90 && b > r * 1.2 && b > g * 1.05;
      }
      if (!matches) continue;
      visited[nIdx] = 1;
      queue.push(nIdx);
    }
  }

  return region;
}

function sampleBackgroundAround(
  pixels: Uint8ClampedArray,
  foregroundMask: Uint8ClampedArray,
  width: number,
  height: number,
  region: Region,
): { r: number; g: number; b: number } {
  let r = 0, g = 0, b = 0, count = 0;
  const margin = 8;

  for (let y = Math.max(0, region.minY - margin); y <= Math.min(height - 1, region.maxY + margin); y++) {
    for (let x = Math.max(0, region.minX - margin); x <= Math.min(width - 1, region.maxX + margin); x++) {
      if (x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY) continue;
      const idx = y * width + x;
      if (foregroundMask[idx * 4 + 3] > 128) continue;
      const o = idx * 4;
      r += pixels[o];
      g += pixels[o + 1];
      b += pixels[o + 2];
      count++;
    }
  }

  if (count === 0) return { r: 200, g: 200, b: 200 };
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

function edgeDistance(x: number, y: number, region: Region): number {
  const dx = Math.min(x - region.minX, region.maxX - x);
  const dy = Math.min(y - region.minY, region.maxY - y);
  return Math.min(dx, dy);
}

/**
 * 차량 유리(윈드실드/사이드 윈도) 위에 반사되어 비치는
 * 엔카 텍스트를 감지하고 주변 유리색으로 블렌딩합니다.
 */
export function removeGlassReflections(
  sourceContext: CanvasRenderingContext2D,
  foregroundMask: Uint8ClampedArray,
  width: number,
  height: number,
): CleanupResult {
  const imageData = sourceContext.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  let removed = 0;
  let uncertain = 0;

  const glassRegions = detectGlassRegions(pixels, foregroundMask, width, height);

  for (const glassRegion of glassRegions) {
    const textPatterns = findTextPatterns(pixels, width, height, glassRegion);

    for (const pattern of textPatterns) {
      if (!isEncarBrandPattern(pixels, pattern)) {
        uncertain++;
        continue;
      }

      inpaintTextPattern(pixels, foregroundMask, width, height, pattern);
      removed++;
    }
  }

  sourceContext.putImageData(imageData, 0, 0);
  return {
    removed,
    uncertain,
    message: removed > 0
      ? `유리 반사 텍스트 ${removed}건 제거${uncertain > 0 ? ` · ${uncertain}건 불확실` : ""}`
      : uncertain > 0
        ? `${uncertain}건 불확실한 반사 패턴 발견 · 검수 필요`
        : "유리 반사 텍스트를 발견하지 못했습니다",
  };
}

type GlassRegion = {
  minX: number; maxX: number;
  minY: number; maxY: number;
  avgBrightness: number;
};

function detectGlassRegions(
  pixels: Uint8ClampedArray,
  foregroundMask: Uint8ClampedArray,
  width: number,
  height: number,
): GlassRegion[] {
  const regions: GlassRegion[] = [];
  let vehicleMinY = height, vehicleMaxY = 0;
  let vehicleMinX = width, vehicleMaxX = 0;

  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      if (foregroundMask[(y * width + x) * 4 + 3] > 128) {
        vehicleMinY = Math.min(vehicleMinY, y);
        vehicleMaxY = Math.max(vehicleMaxY, y);
        vehicleMinX = Math.min(vehicleMinX, x);
        vehicleMaxX = Math.max(vehicleMaxX, x);
      }
    }
  }

  if (vehicleMaxY <= vehicleMinY) return regions;

  const vehicleHeight = vehicleMaxY - vehicleMinY;
  const glassTop = vehicleMinY + vehicleHeight * 0.15;
  const glassBottom = vehicleMinY + vehicleHeight * 0.55;

  const blockSize = 20;
  for (let by = Math.floor(glassTop / blockSize); by < Math.ceil(glassBottom / blockSize); by++) {
    for (let bx = Math.floor(vehicleMinX / blockSize); bx < Math.ceil(vehicleMaxX / blockSize); bx++) {
      let brightness = 0, saturation = 0, total = 0;

      for (let y = by * blockSize; y < Math.min(height, (by + 1) * blockSize); y++) {
        for (let x = bx * blockSize; x < Math.min(width, (bx + 1) * blockSize); x++) {
          const idx = y * width + x;
          if (foregroundMask[idx * 4 + 3] < 128) continue;
          const o = idx * 4;
          const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
          const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
          brightness += lum;
          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          saturation += maxC > 0 ? (maxC - minC) / maxC : 0;
          total++;
        }
      }

      if (total < blockSize * blockSize * 0.3) continue;
      const avgBright = brightness / total;
      const avgSat = saturation / total;

      if (avgBright > 80 && avgSat < 0.35) {
        regions.push({
          minX: bx * blockSize,
          maxX: Math.min(width, (bx + 1) * blockSize) - 1,
          minY: by * blockSize,
          maxY: Math.min(height, (by + 1) * blockSize) - 1,
          avgBrightness: avgBright,
        });
      }
    }
  }

  return mergeAdjacentRegions(regions, blockSize);
}

function mergeAdjacentRegions(regions: GlassRegion[], blockSize: number): GlassRegion[] {
  if (regions.length === 0) return [];
  const merged: GlassRegion[] = [];
  const used = new Set<number>();

  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;
    const current = { ...regions[i] };
    used.add(i);

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < regions.length; j++) {
        if (used.has(j)) continue;
        const other = regions[j];
        if (
          Math.abs(current.maxX - other.minX) <= blockSize &&
          current.minY <= other.maxY && current.maxY >= other.minY
        ) {
          current.minX = Math.min(current.minX, other.minX);
          current.maxX = Math.max(current.maxX, other.maxX);
          current.minY = Math.min(current.minY, other.minY);
          current.maxY = Math.max(current.maxY, other.maxY);
          current.avgBrightness = (current.avgBrightness + other.avgBrightness) / 2;
          used.add(j);
          changed = true;
        }
      }
    }
    merged.push(current);
  }
  return merged;
}

type TextPattern = {
  pixels: number[];
  minX: number; maxX: number;
  minY: number; maxY: number;
};

function findTextPatterns(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  glassRegion: GlassRegion,
): TextPattern[] {
  const patterns: TextPattern[] = [];
  const visited = new Uint8Array(width * height);

  for (let y = glassRegion.minY; y <= glassRegion.maxY; y++) {
    for (let x = glassRegion.minX; x <= glassRegion.maxX; x++) {
      const idx = y * width + x;
      if (visited[idx]) continue;

      const o = idx * 4;
      const lum = pixels[o] * 0.2126 + pixels[o + 1] * 0.7152 + pixels[o + 2] * 0.0722;

      let surroundLum = 0, surroundCount = 0;
      for (let dy = -5; dy <= 5; dy += 5) {
        for (let dx = -5; dx <= 5; dx += 5) {
          if (dx === 0 && dy === 0) continue;
          const sx = x + dx, sy = y + dy;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
          const so = (sy * width + sx) * 4;
          surroundLum += pixels[so] * 0.2126 + pixels[so + 1] * 0.7152 + pixels[so + 2] * 0.0722;
          surroundCount++;
        }
      }
      if (surroundCount === 0) continue;
      const avgSurround = surroundLum / surroundCount;

      const contrast = Math.abs(lum - avgSurround);
      if (contrast < 35) continue;

      const pattern: TextPattern = { pixels: [], minX: x, maxX: x, minY: y, maxY: y };
      const queue = [idx];
      visited[idx] = 1;
      let cursor = 0;

      while (cursor < queue.length && queue.length < 5000) {
        const ci = queue[cursor++];
        const px = ci % width;
        const py = Math.floor(ci / width);
        pattern.pixels.push(ci);
        pattern.minX = Math.min(pattern.minX, px);
        pattern.maxX = Math.max(pattern.maxX, px);
        pattern.minY = Math.min(pattern.minY, py);
        pattern.maxY = Math.max(pattern.maxY, py);

        for (const [ndx, ndy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nx = px + ndx, ny = py + ndy;
          if (nx < glassRegion.minX || nx > glassRegion.maxX || ny < glassRegion.minY || ny > glassRegion.maxY) continue;
          const ni = ny * width + nx;
          if (visited[ni]) continue;
          const no = ni * 4;
          const nLum = pixels[no] * 0.2126 + pixels[no + 1] * 0.7152 + pixels[no + 2] * 0.0722;
          if (Math.abs(nLum - lum) < 40) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }

      if (pattern.pixels.length >= 15 && pattern.pixels.length <= 8000) {
        patterns.push(pattern);
      }
    }
  }

  return patterns;
}

function isEncarBrandPattern(
  pixels: Uint8ClampedArray,
  pattern: TextPattern,
): boolean {
  let whiteCount = 0, brightCount = 0;

  for (const idx of pattern.pixels) {
    const o = idx * 4;
    const lum = pixels[o] * 0.2126 + pixels[o + 1] * 0.7152 + pixels[o + 2] * 0.0722;
    if (lum > 200) whiteCount++;
    if (lum > 150) brightCount++;
  }

  const whiteRatio = whiteCount / pattern.pixels.length;
  const brightRatio = brightCount / pattern.pixels.length;

  const patternWidth = pattern.maxX - pattern.minX + 1;
  const patternHeight = pattern.maxY - pattern.minY + 1;
  const aspect = patternWidth / Math.max(1, patternHeight);
  const density = pattern.pixels.length / Math.max(1, patternWidth * patternHeight);

  return (whiteRatio > 0.58 || brightRatio > 0.76)
    && aspect > 1.7 && aspect < 14
    && density > 0.06 && density < 0.72
    && patternHeight <= 90;
}

function inpaintTextPattern(
  pixels: Uint8ClampedArray,
  foregroundMask: Uint8ClampedArray,
  width: number,
  height: number,
  pattern: TextPattern,
) {
  const original = new Uint8ClampedArray(pixels);
  const targets = new Set<number>();
  for (const pixel of pattern.pixels) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (foregroundMask[next * 4 + 3] > 96) targets.add(next);
      }
    }
  }

  const leftX = Math.max(0, pattern.minX - 4);
  const rightX = Math.min(width - 1, pattern.maxX + 4);
  const topY = Math.max(0, pattern.minY - 4);
  const bottomY = Math.min(height - 1, pattern.maxY + 4);
  const colorDistance = (a: number, b: number) => (
    Math.abs(original[a] - original[b])
    + Math.abs(original[a + 1] - original[b + 1])
    + Math.abs(original[a + 2] - original[b + 2])
  );

  for (const pixel of targets) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const offset = pixel * 4;
    const left = (y * width + leftX) * 4;
    const right = (y * width + rightX) * 4;
    const top = (topY * width + x) * 4;
    const bottom = (bottomY * width + x) * 4;
    const horizontal = colorDistance(left, right) <= colorDistance(top, bottom);
    const start = horizontal ? left : top;
    const end = horizontal ? right : bottom;
    const t = horizontal
      ? (x - leftX) / Math.max(1, rightX - leftX)
      : (y - topY) / Math.max(1, bottomY - topY);
    const feather = pattern.pixels.includes(pixel) ? 0.84 : 0.48;
    for (let channel = 0; channel < 3; channel += 1) {
      const replacement = original[start + channel] * (1 - t) + original[end + channel] * t;
      pixels[offset + channel] = Math.round(original[offset + channel] * (1 - feather) + replacement * feather);
    }
  }
}

function sampleGlassColor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  pattern: TextPattern,
): { r: number; g: number; b: number } {
  let r = 0, g = 0, b = 0, count = 0;
  const margin = 10;

  for (let y = Math.max(0, pattern.minY - margin); y <= Math.min(height - 1, pattern.maxY + margin); y++) {
    for (let x = Math.max(0, pattern.minX - margin); x <= Math.min(width - 1, pattern.maxX + margin); x++) {
      if (x >= pattern.minX && x <= pattern.maxX && y >= pattern.minY && y <= pattern.maxY) continue;
      const o = (y * width + x) * 4;
      r += pixels[o];
      g += pixels[o + 1];
      b += pixels[o + 2];
      count++;
    }
  }

  if (count === 0) return { r: 160, g: 160, b: 160 };
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}
