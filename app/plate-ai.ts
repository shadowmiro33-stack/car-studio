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
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < Math.min(300, logits.length); index += 1) {
    const score = 1 / (1 + Math.exp(-logits[index]));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  if (bestIndex < 0 || bestScore < 0.05) return null;
  const offset = bestIndex * 4;
  const cx = boxes[offset];
  const cy = boxes[offset + 1];
  const boxWidth = boxes[offset + 2];
  const boxHeight = boxes[offset + 3];
  return {
    source: "model",
    left: Math.max(0, (cx - boxWidth / 2) * width),
    top: Math.max(0, (cy - boxHeight / 2) * height),
    right: Math.min(width, (cx + boxWidth / 2) * width),
    bottom: Math.min(height, (cy + boxHeight / 2) * height),
    score: bestScore,
  };
}

function isPlausiblePlateBox(plate: PlateBox, width: number, height: number) {
  const plateWidth = plate.right - plate.left;
  const plateHeight = plate.bottom - plate.top;
  const aspectRatio = plateWidth / Math.max(1, plateHeight);
  const areaRatio = (plateWidth * plateHeight) / (width * height);
  const redDealer = plate.source === "red-dealer";
  return aspectRatio >= (redDealer ? 1.15 : 1.8) && aspectRatio <= 7
    && areaRatio >= 0.0025 && areaRatio <= (redDealer ? 0.08 : 0.03)
    && plate.left >= width * 0.05 && plate.right <= width * 0.95
    && plate.top >= height * 0.3 && plate.bottom <= height * (redDealer ? 0.97 : 0.88);
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
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      if (x >= excluded.left && x <= excluded.right && y >= excluded.top && y <= excluded.bottom) continue;
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      if (red > 120 && red > green * 1.4 && red > blue * 1.4) redPixels += 1;
    }
  }
  return redPixels / ((xEnd - xStart) * (yEnd - yStart));
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
  const ort = await import("onnxruntime-web");
  const session = await getDetectorSession();
  const tensor = imageToTensor(ort, image);
  let output: Record<string, import("onnxruntime-web").Tensor> | null = null;
  try {
    output = await session.run({ pixel_values: tensor });
    const result = topPlateBox(output, image.naturalWidth, image.naturalHeight);
    if (!result || result.score < 0.08) {
      return { type: "other", points: [], score: result?.score ?? null, message: "전면 번호판을 확실하게 찾지 못했습니다. 네 모서리를 직접 지정할 수 있습니다." };
    }
    if (!isPlausiblePlateBox(result, image.naturalWidth, image.naturalHeight)) {
      return { type: "other", points: [], score: result.score, message: "후보 위치가 전면 번호판 조건과 맞지 않아 자동 적용하지 않았습니다." };
    }
    const rearRatio = redLightRatio(image, result);
    const points = boxPoints(result);
    if (rearRatio >= 0.005) {
      return { type: "rear", points, score: result.score, message: "번호판 후보를 찾았습니다. 촬영 각도에 맞게 네 앵커를 확인해 주세요." };
    }
    if (rearRatio > 0.002) {
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
  context.save();
  context.beginPath();
  context.moveTo(destinationPoints[0].x, destinationPoints[0].y);
  context.lineTo(destinationPoints[1].x, destinationPoints[1].y);
  context.lineTo(destinationPoints[2].x, destinationPoints[2].y);
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
