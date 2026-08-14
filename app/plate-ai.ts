export type PlatePoint = { x: number; y: number };

export type PlateDetection = {
  type: "front" | "rear" | "other" | "unknown";
  points: PlatePoint[];
  score: number | null;
  message: string;
};

type PlateBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  score: number;
  source?: "model" | "red-dealer";
  points?: PlatePoint[];
};

let detectorSession: import("onnxruntime-web").InferenceSession | null = null;

function imageToTensor(ort: typeof import("onnxruntime-web"), image: HTMLImageElement) {
  const size = 640;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("번호판 분석 화면을 만들 수 없습니다.");
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const values = new Float32Array(3 * size * size);
  for (let index = 0; index < size * size; index += 1) {
    values[index] = pixels[index * 4] / 255;
    values[size * size + index] = pixels[index * 4 + 1] / 255;
    values[2 * size * size + index] = pixels[index * 4 + 2] / 255;
  }
  return new ort.Tensor("float32", values, [1, 3, size, size]);
}

async function getDetectorSession() {
  if (detectorSession) return detectorSession;
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";
  detectorSession = await ort.InferenceSession.create("/api/plate-model", {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return detectorSession;
}

function topPlateBox(output: Record<string, import("onnxruntime-web").Tensor>, width: number, height: number): PlateBox | null {
  const logits = output.logits?.data as Float32Array | undefined;
  const boxes = output.pred_boxes?.data as Float32Array | undefined;
  if (!logits || !boxes) return null;
  
  const candidates: PlateBox[] = [];
  for (let index = 0; index < Math.min(300, logits.length); index += 1) {
    const score = 1 / (1 + Math.exp(-logits[index]));
    if (score >= 0.03) {
      const offset = index * 4;
      const cx = boxes[offset];
      const cy = boxes[offset + 1];
      const boxWidth = boxes[offset + 2];
      const boxHeight = boxes[offset + 3];
      const candidate: PlateBox = {
        source: "model",
        left: Math.max(0, (cx - boxWidth / 2) * width),
        top: Math.max(0, (cy - boxHeight / 2) * height),
        right: Math.min(width, (cx + boxWidth / 2) * width),
        bottom: Math.min(height, (cy + boxHeight / 2) * height),
        score,
      };
      if (isPlausiblePlateBox(candidate, width, height)) {
        candidates.push(candidate);
      }
    }
  }

  if (candidates.length === 0) return null;
  // 높은 점수 + 중앙 또는 하단에 위치한 최적의 번호판 후보 선택
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function isPlausiblePlateBox(plate: PlateBox, width: number, height: number) {
  const plateWidth = plate.right - plate.left;
  const plateHeight = plate.bottom - plate.top;
  const aspectRatio = plateWidth / Math.max(1, plateHeight);
  const areaRatio = (plateWidth * plateHeight) / (width * height);
  const redDealer = plate.source === "red-dealer";
  // 측면/원근 사진에서 번호판 종횡비가 0.6~7.5까지 크게 왜곡될 수 있음
  return aspectRatio >= 0.35 && aspectRatio <= 8.5
    && areaRatio >= (redDealer ? 0.00035 : 0.0006) && areaRatio <= (redDealer ? 0.08 : 0.05)
    && plate.left >= width * 0.01 && plate.right <= width * 0.99
    && plate.top >= height * 0.15 && plate.bottom <= height * (redDealer ? 0.98 : 0.92);
}

function findRedDealerPlate(image: HTMLImageElement): PlateBox | null {
  const width = 720;
  const height = Math.max(1, Math.round(width * image.naturalHeight / image.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const visited = new Uint8Array(width * height);
  let best: { area: number; left: number; top: number; right: number; bottom: number; members: number[]; rank: number } | null = null;
  
  // 차체 전면/측면 하단부에 위치하는 Encar 빨간 딜러 플레이트 탐색
  const yStart = Math.floor(height * 0.32);
  for (let y = yStart; y < height * 0.96; y += 1) {
    for (let x = Math.floor(width * 0.02); x < width * 0.98; x += 1) {
      const start = y * width + x;
      if (visited[start]) continue;
      const offset = start * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      // 어두운 촬영에서도 동작하되 회색 차체와 테일램프 하이라이트는 제외한다.
      if (!(red > 82 && red - Math.max(green, blue) > 24 && red > green * 1.22 && red > blue * 1.18)) continue;
      const queue = [start];
      const members: number[] = [];
      visited[start] = 1;
      let cursor = 0;
      let area = 0;
      let left = x;
      let right = x;
      let top = y;
      let bottom = y;
      while (cursor < queue.length) {
        const index = queue[cursor++];
        const px = index % width;
        const py = Math.floor(index / width);
        members.push(index);
        area += 1;
        left = Math.min(left, px); right = Math.max(right, px);
        top = Math.min(top, py); bottom = Math.max(bottom, py);
        for (const neighbor of [index - 1, index + 1, index - width, index + width]) {
          if (neighbor < 0 || neighbor >= width * height || visited[neighbor]) continue;
          const nx = neighbor % width;
          const ny = Math.floor(neighbor / width);
          if (Math.abs(nx - px) + Math.abs(ny - py) !== 1) continue;
          const no = neighbor * 4;
          const nr = pixels[no], ng = pixels[no + 1], nb = pixels[no + 2];
          if (nr > 68 && nr - Math.max(ng, nb) > 15 && nr > ng * 1.13 && nr > nb * 1.1) {
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
      }
      const componentWidth = right - left + 1;
      const componentHeight = bottom - top + 1;
      const aspect = componentWidth / Math.max(1, componentHeight);
      const centerRatio = ((left + right) / 2) / width;
      const widthRatio = componentWidth / width;
      const heightRatio = componentHeight / height;
      const topRatio = top / height;
      const centerYRatio = ((top + bottom) / 2) / height;
      const fillRatio = area / Math.max(1, componentWidth * componentHeight);
      const centerBonus = 1 - Math.min(1, Math.abs(centerRatio - 0.5) * 1.55);
      const lowerBonus = Math.max(0, Math.min(1, (centerYRatio - 0.38) / 0.5));
      const rank = fillRatio * 3 + centerBonus * 0.9 + lowerBonus * 0.45 + Math.min(0.7, area / (width * height) * 45);
      if (
        area > 70
        && aspect >= 1.05 && aspect <= 8.5
        && centerRatio >= 0.07 && centerRatio <= 0.93
        && topRatio >= 0.32
        && widthRatio >= 0.035 && widthRatio <= 0.42
        && heightRatio >= 0.012 && heightRatio <= 0.18
        && fillRatio >= 0.2
        && (!best || rank > best.rank)
      ) best = { area, left, top, right, bottom, members, rank };
    }
  }
  if (!best) return null;
  const columnTop = new Map<number, number>();
  const columnBottom = new Map<number, number>();
  for (const index of best.members) {
    const x = index % width;
    const y = Math.floor(index / width);
    columnTop.set(x, Math.min(columnTop.get(x) ?? y, y));
    columnBottom.set(x, Math.max(columnBottom.get(x) ?? y, y));
  }
  const fit = (values: Map<number, number>) => {
    const samples = [...values.entries()].filter(([x]) => x > best!.left + 1 && x < best!.right - 1);
    if (samples.length < 3) return { slope: 0, intercept: values.values().next().value ?? 0 };
    const meanX = samples.reduce((sum, [x]) => sum + x, 0) / samples.length;
    const meanY = samples.reduce((sum, [, y]) => sum + y, 0) / samples.length;
    let numerator = 0;
    let denominator = 0;
    for (const [x, y] of samples) {
      numerator += (x - meanX) * (y - meanY);
      denominator += (x - meanX) ** 2;
    }
    const slope = denominator ? numerator / denominator : 0;
    return { slope, intercept: meanY - slope * meanX };
  };
  const topLine = fit(columnTop);
  const bottomLine = fit(columnBottom);
  const padX = Math.max(2, (best.right - best.left) * 0.035);
  const padY = Math.max(2, (best.bottom - best.top) * 0.07);
  const left = Math.max(0, best.left - padX);
  const right = Math.min(width, best.right + padX);
  const toSource = (x: number, y: number): PlatePoint => ({
    x: x / width * image.naturalWidth,
    y: y / height * image.naturalHeight,
  });
  const points = [
    toSource(left, topLine.slope * left + topLine.intercept - padY),
    toSource(right, topLine.slope * right + topLine.intercept - padY),
    toSource(right, bottomLine.slope * right + bottomLine.intercept + padY),
    toSource(left, bottomLine.slope * left + bottomLine.intercept + padY),
  ];
  return {
    source: "red-dealer",
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
    points,
    score: Math.min(0.99, 0.78 + best.rank * 0.045),
  };
}

function redLightRatio(image: HTMLImageElement, excludedPlate: PlateBox) {
  const width = 320;
  const height = 192;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 1;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const xStart = Math.round(width * 0.15);
  const xEnd = Math.round(width * 0.85);
  const yStart = Math.round(height * 0.28);
  const yEnd = Math.round(height * 0.68);
  const excluded = {
    left: excludedPlate.left / image.naturalWidth * width - 5,
    right: excludedPlate.right / image.naturalWidth * width + 5,
    top: excludedPlate.top / image.naturalHeight * height - 4,
    bottom: excludedPlate.bottom / image.naturalHeight * height + 4,
  };
  let redPixels = 0;
  // 추가: 차량 양 끝 영역(좌측 25%와 우측 25%)의 테일라이트 집중도
  let edgeRedPixels = 0;
  let edgeTotal = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      if (x >= excluded.left && x <= excluded.right && y >= excluded.top && y <= excluded.bottom) continue;
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const isRed = red > 120 && red > green * 1.4 && red > blue * 1.4;
      if (isRed) redPixels += 1;
      // 양 끝 영역 집중도 체크 (테일라이트는 양 끝에 집중)
      const inEdge = x < xStart + (xEnd - xStart) * 0.25 || x > xEnd - (xEnd - xStart) * 0.25;
      if (inEdge) {
        edgeTotal++;
        if (isRed) edgeRedPixels++;
      }
    }
  }
  const totalArea = (xEnd - xStart) * (yEnd - yStart);
  const overallRatio = redPixels / totalArea;
  const edgeRatio = edgeTotal > 0 ? edgeRedPixels / edgeTotal : 0;

  // 번호판 수직 위치 분석: 후면 번호판은 보통 더 낮은 위치
  const plateVerticalCenter = (excludedPlate.top + excludedPlate.bottom) / 2 / image.naturalHeight;
  const lowPlateBonus = plateVerticalCenter > 0.7 ? 0.003 : 0;

  // 차량 중심선 대비 번호판 수평 오프셋 (측후면 판별)
  const plateCenterX = (excludedPlate.left + excludedPlate.right) / 2 / image.naturalWidth;
  const offsetBonus = Math.abs(plateCenterX - 0.5) > 0.2 ? 0.002 : 0;

  // 테일라이트 양 끝 집중 보너스
  const edgeConcentrationBonus = edgeRatio > overallRatio * 2 ? 0.002 : 0;

  return overallRatio + lowPlateBonus + offsetBonus + edgeConcentrationBonus;
}

function boxPoints(box: PlateBox) {
  return box.points ?? [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
}

export async function detectFrontPlate(image: HTMLImageElement): Promise<PlateDetection> {
  const redResult = findRedDealerPlate(image);
  if (redResult && isPlausiblePlateBox(redResult, image.naturalWidth, image.naturalHeight)) {
    const rearRatio = redLightRatio(image, redResult);
    if (rearRatio >= 0.014) {
      return {
        type: "rear",
        points: boxPoints(redResult),
        score: redResult.score,
        message: "후면 딜러 플레이트로 판단해 자동 교체하지 않았습니다.",
      };
    }
    return {
      type: "front",
      points: boxPoints(redResult),
      score: redResult.score,
      message: "전면·측면 딜러 플레이트를 감지했습니다. 기울기와 실제 크기에 맞춰 교체합니다.",
    };
  }
  const ort = await import("onnxruntime-web");
  const session = await getDetectorSession();
  const tensor = imageToTensor(ort, image);
  let output: Record<string, import("onnxruntime-web").Tensor> | null = null;
  try {
    output = await session.run({ pixel_values: tensor });
    const modelResult = topPlateBox(output, image.naturalWidth, image.naturalHeight);
    const result = modelResult;
    if (!result || result.score < 0.045) {
      return { type: "other", points: [], score: result?.score ?? null, message: "전면 번호판을 확실하게 찾지 못했습니다. 네 모서리를 직접 지정할 수 있습니다." };
    }
    if (!isPlausiblePlateBox(result, image.naturalWidth, image.naturalHeight)) {
      return { type: "other", points: [], score: result.score, message: "후보 위치가 전면 번호판 조건과 맞지 않아 자동 적용하지 않았습니다." };
    }
    const rearRatio = redLightRatio(image, result);
    const points = boxPoints(result);
    if (rearRatio >= 0.014) {
      return { type: "rear", points, score: result.score, message: "번호판 후보를 찾았습니다. 촬영 각도에 맞게 네 앵커를 확인해 주세요." };
    }
    if (rearRatio > 0.009) {
      return { type: "unknown", points, score: result.score, message: "비스듬한 번호판 후보를 찾았습니다. 네 앵커를 조정한 뒤 적용할 수 있습니다." };
    }
    return { type: "front", points, score: result.score, message: "번호판을 찾았습니다. 네 앵커를 드래그해 투시 각도를 조정할 수 있습니다." };
  } finally {
    tensor.dispose();
    if (output) Object.values(output).forEach((value) => value.dispose());
  }
}

export function drawPerspectivePlate(
  context: CanvasRenderingContext2D,
  logo: HTMLImageElement,
  points: PlatePoint[],
) {
  if (points.length !== 4) return;
  const layer = document.createElement("canvas");
  layer.width = 1400;
  layer.height = 320;
  const layerContext = layer.getContext("2d");
  if (!layerContext) return;
  layerContext.fillStyle = "#1764c7";
  layerContext.fillRect(0, 0, layer.width, layer.height);
  const logoWidth = Math.min(layer.width * 0.78, layer.height * (logo.naturalWidth / logo.naturalHeight));
  const logoHeight = logoWidth * (logo.naturalHeight / logo.naturalWidth);
  layerContext.drawImage(logo, (layer.width - logoWidth) / 2, (layer.height - logoHeight) / 2, logoWidth, logoHeight);

  const columns = 14;
  const rows = 4;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const u0 = column / columns;
      const u1 = (column + 1) / columns;
      const v0 = row / rows;
      const v1 = (row + 1) / rows;
      const sourceA = [{ x: u0 * layer.width, y: v0 * layer.height }, { x: u1 * layer.width, y: v0 * layer.height }, { x: u1 * layer.width, y: v1 * layer.height }];
      const sourceB = [sourceA[0], sourceA[2], { x: u0 * layer.width, y: v1 * layer.height }];
      const destinationA = [bilinear(points, u0, v0), bilinear(points, u1, v0), bilinear(points, u1, v1)];
      const destinationB = [destinationA[0], destinationA[2], bilinear(points, u0, v1)];
      paintTriangle(context, layer, sourceA, destinationA);
      paintTriangle(context, layer, sourceB, destinationB);
    }
  }
}

function bilinear([p0, p1, p2, p3]: PlatePoint[], u: number, v: number) {
  return {
    x: p0.x * (1 - u) * (1 - v) + p1.x * u * (1 - v) + p2.x * u * v + p3.x * (1 - u) * v,
    y: p0.y * (1 - u) * (1 - v) + p1.y * u * (1 - v) + p2.y * u * v + p3.y * (1 - u) * v,
  };
}

function paintTriangle(context: CanvasRenderingContext2D, source: HTMLCanvasElement, sourcePoints: PlatePoint[], destinationPoints: PlatePoint[]) {
  const transform = affineTransform(sourcePoints, destinationPoints);
  const center = destinationPoints.reduce(
    (sum, point) => ({ x: sum.x + point.x / 3, y: sum.y + point.y / 3 }),
    { x: 0, y: 0 },
  );
  const clipPoints = destinationPoints.map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + dx / length * 0.8, y: point.y + dy / length * 0.8 };
  });
  context.save();
  context.beginPath();
  context.moveTo(clipPoints[0].x, clipPoints[0].y);
  context.lineTo(clipPoints[1].x, clipPoints[1].y);
  context.lineTo(clipPoints[2].x, clipPoints[2].y);
  context.closePath();
  context.clip();
  context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  context.drawImage(source, 0, 0);
  context.restore();
}

function affineTransform([p0, p1, p2]: PlatePoint[], [q0, q1, q2]: PlatePoint[]) {
  const denominator = p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y);
  const a = (q0.x * (p1.y - p2.y) + q1.x * (p2.y - p0.y) + q2.x * (p0.y - p1.y)) / denominator;
  const c = (q0.x * (p2.x - p1.x) + q1.x * (p0.x - p2.x) + q2.x * (p1.x - p0.x)) / denominator;
  const e = (q0.x * (p1.x * p2.y - p2.x * p1.y) + q1.x * (p2.x * p0.y - p0.x * p2.y) + q2.x * (p0.x * p1.y - p1.x * p0.y)) / denominator;
  const b = (q0.y * (p1.y - p2.y) + q1.y * (p2.y - p0.y) + q2.y * (p0.y - p1.y)) / denominator;
  const d = (q0.y * (p2.x - p1.x) + q1.y * (p0.x - p2.x) + q2.y * (p1.x - p0.x)) / denominator;
  const f = (q0.y * (p1.x * p2.y - p2.x * p1.y) + q1.y * (p2.x * p0.y - p0.x * p2.y) + q2.y * (p0.x * p1.y - p1.x * p0.y)) / denominator;
  return { a, b, c, d, e, f };
}
