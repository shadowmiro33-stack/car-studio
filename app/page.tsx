"use client";

import { ChangeEvent, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { detectFrontPlate, drawPerspectivePlate, type PlateDetection, type PlatePoint } from "./plate-ai";
import { blankPlateRegion, removeDisplayStickers, removeGlassReflections, type CleanupResult } from "./encar-cleanup";
import JSZip from "jszip";

type Backdrop = "studio" | "warm" | "graphite";
type Ratio = "original" | "16:9" | "4:3" | "1:1";
type SceneKind = "studio";
type PlateCoordinates = "source" | "canvas";
type PlateAction = "replace" | "blank" | "none";
type WallStripPlacement = { x: number; y: number; scale: number };
type EncarCleanupOptions = {
  stickerRemoval: boolean;
  glassReflection: boolean;
};

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

type SubjectBounds = { x: number; y: number; width: number; height: number };
type BottomPoint = { x: number; y: number };
type LightEstimate = { castDirection: number; projectionScale: number; opacity: number };

function getSubjectBounds(image: HTMLImageElement): SubjectBounds {
  const analysisSize = 720;
  const scale = Math.min(1, analysisSize / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { x: 0, y: 0, width: image.width, height: image.height };
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] < 36) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width: image.width, height: image.height };
  const padding = 4;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);
  return {
    x: Math.round((minX / width) * image.width),
    y: Math.round((minY / height) * image.height),
    width: Math.max(1, Math.round(((maxX - minX + 1) / width) * image.width)),
    height: Math.max(1, Math.round(((maxY - minY + 1) / height) * image.height)),
  };
}

function getBottomProfile(image: HTMLImageElement, bounds: SubjectBounds): BottomPoint[] {
  const analysisWidth = Math.min(900, Math.max(360, Math.round(bounds.width)));
  const analysisHeight = Math.max(1, Math.round(analysisWidth * (bounds.height / bounds.width)));
  const canvas = document.createElement("canvas");
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, analysisWidth, analysisHeight);
  const pixels = context.getImageData(0, 0, analysisWidth, analysisHeight).data;
  const points: BottomPoint[] = [];
  const step = Math.max(2, Math.round(analysisWidth / 220));
  for (let x = 0; x < analysisWidth; x += step) {
    let bottom = -1;
    for (let sampleX = Math.max(0, x - step); sampleX <= Math.min(analysisWidth - 1, x + step); sampleX += 1) {
      for (let y = analysisHeight - 1; y >= Math.round(analysisHeight * 0.58); y -= 1) {
        if (pixels[(y * analysisWidth + sampleX) * 4 + 3] > 56) {
          bottom = Math.max(bottom, y);
          break;
        }
      }
    }
    if (bottom >= analysisHeight * 0.7) {
      points.push({ x: x / analysisWidth, y: bottom / analysisHeight });
    }
  }
  return points;
}

function estimateLight(image: HTMLImageElement, bounds: SubjectBounds): LightEstimate {
  const analysisWidth = 320;
  const analysisHeight = Math.max(1, Math.round(analysisWidth * (bounds.height / bounds.width)));
  const canvas = document.createElement("canvas");
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { castDirection: 0, projectionScale: 0.12, opacity: 0.2 };
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, analysisWidth, analysisHeight);
  const pixels = context.getImageData(0, 0, analysisWidth, analysisHeight).data;
  let leftLight = 0;
  let rightLight = 0;
  let leftWeight = 0;
  let rightWeight = 0;
  let subjectLight = 0;
  let subjectWeight = 0;

  for (let y = 0; y < analysisHeight * 0.82; y += 3) {
    for (let x = 0; x < analysisWidth; x += 3) {
      const offset = (Math.floor(y) * analysisWidth + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      if (alpha < 0.55) continue;
      const luminance = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
      const highlightWeight = alpha * Math.pow(luminance / 255, 2.4);
      subjectLight += luminance * alpha;
      subjectWeight += alpha;
      if (x < analysisWidth / 2) {
        leftLight += luminance * highlightWeight;
        leftWeight += highlightWeight;
      } else {
        rightLight += luminance * highlightWeight;
        rightWeight += highlightWeight;
      }
    }
  }

  const leftAverage = leftWeight ? leftLight / leftWeight : 128;
  const rightAverage = rightWeight ? rightLight / rightWeight : 128;
  const brightness = subjectWeight ? subjectLight / subjectWeight : 150;
  const rawDirection = (leftAverage - rightAverage) / 34;
  const castDirection = Math.max(-1, Math.min(1, Math.abs(rawDirection) < 0.12 ? 0 : rawDirection));
  return {
    castDirection,
    projectionScale: 0.105 + Math.abs(castDirection) * 0.055,
    opacity: Math.max(0.16, Math.min(0.27, 0.25 - brightness / 1800)),
  };
}

function estimateFloorHorizon(source: HTMLImageElement, foreground: HTMLImageElement) {
  const width = 420;
  const height = Math.max(1, Math.round(width * (source.height / source.width)));
  const sourceCanvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  sourceCanvas.width = maskCanvas.width = width;
  sourceCanvas.height = maskCanvas.height = height;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext || !maskContext) return 0.7;
  sourceContext.drawImage(source, 0, 0, width, height);
  maskContext.drawImage(foreground, 0, 0, width, height);
  const pixels = sourceContext.getImageData(0, 0, width, height).data;
  const mask = maskContext.getImageData(0, 0, width, height).data;
  let bestRow = Math.round(height * 0.7);
  let bestScore = 0;

  for (let y = Math.round(height * 0.5); y <= Math.round(height * 0.82); y += 1) {
    let score = 0;
    let samples = 0;
    for (let x = 3; x < width - 3; x += 3) {
      const upper = ((y - 2) * width + x) * 4;
      const lower = ((y + 2) * width + x) * 4;
      if (mask[upper + 3] > 42 || mask[lower + 3] > 42) continue;
      const upperLight = pixels[upper] * 0.2126 + pixels[upper + 1] * 0.7152 + pixels[upper + 2] * 0.0722;
      const lowerLight = pixels[lower] * 0.2126 + pixels[lower + 1] * 0.7152 + pixels[lower + 2] * 0.0722;
      score += Math.abs(upperLight - lowerLight);
      samples += 1;
    }
    if (samples < 24) continue;
    const average = score / samples;
    if (average > bestScore) {
      bestScore = average;
      bestRow = y;
    }
  }

  return Math.max(0.56, Math.min(0.8, bestRow / height));
}

function drawProjectedShadow(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  bounds: SubjectBounds,
  drawX: number,
  drawY: number,
  drawWidth: number,
  drawHeight: number,
  floorY: number,
  canvasWidth: number,
  canvasHeight: number,
  backdrop: Backdrop,
) {
  const light = estimateLight(image, bounds);
  const slope = light.castDirection * 0.22;
  const shadowOpacity = backdrop === "graphite" ? light.opacity * 1.45 : light.opacity;

  context.save();
  context.beginPath();
  context.rect(0, floorY - Math.max(2, canvasHeight * 0.003), canvasWidth, canvasHeight - floorY + 8);
  context.clip();
  context.filter = `brightness(0) saturate(0) blur(${Math.max(6, canvasWidth * 0.0045)}px) opacity(${shadowOpacity})`;
  context.transform(
    1,
    0,
    -slope,
    -light.projectionScale,
    slope * floorY,
    floorY * (1 + light.projectionScale),
  );
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, drawX, drawY, drawWidth, drawHeight);
  context.restore();

  context.save();
  context.filter = `blur(${Math.max(3, canvasWidth * 0.0022)}px)`;
  context.fillStyle = backdrop === "graphite" ? "rgba(0,0,0,.5)" : "rgba(10,13,15,.32)";
  context.beginPath();
  context.ellipse(
    drawX + drawWidth * (0.5 + light.castDirection * 0.018),
    floorY,
    drawWidth * 0.29,
    Math.max(4, canvasHeight * 0.007),
    0,
    0,
    Math.PI * 2,
  );
  context.fill();
  context.restore();
}

function largestAlphaComponent(pixels: Uint8ClampedArray, width: number, height: number) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 620));
  const gridWidth = Math.ceil(width / step);
  const gridHeight = Math.ceil(height / step);
  const mask = new Uint8Array(gridWidth * gridHeight);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      let solid = 0;
      for (let y = gy * step; y < Math.min(height, (gy + 1) * step); y += 1) {
        for (let x = gx * step; x < Math.min(width, (gx + 1) * step); x += 1) {
          const idx = (y * width + x) * 4;
          const alpha = pixels[idx + 3];
          // 어두운 배경/검은 차체 사진 고려: 알파 120 이상이거나 반투명 영역 포함
          if (alpha > 120) solid += 1;
        }
      }
      if (solid >= Math.max(1, step * step * 0.22)) mask[gy * gridWidth + gx] = 1;
    }
  }
  const visited = new Uint8Array(mask.length);
  let largest: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    const component: number[] = [];
    visited[start] = 1;
    let cursor = 0;
    while (cursor < queue.length) {
      const index = queue[cursor++];
      component.push(index);
      const x = index % gridWidth;
      const y = Math.floor(index / gridWidth);
      for (const next of [index - 1, index + 1, index - gridWidth, index + gridWidth]) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nx = next % gridWidth;
        const ny = Math.floor(next / gridWidth);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const keep = new Uint8Array(mask.length);
  largest.forEach((index) => { keep[index] = 1; });
  return { keep, step, gridWidth };
}

/**
 * 차량 루프(천장) 라인 위에 붕 떠서 남아있는 배경 전광판/글자 조각('En' 등)을 감지 및 제거합니다.
 */
function removeRoofArtifacts(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  subjectBounds: { minX: number; maxX: number; minY: number; maxY: number },
): void {
  const subjectWidth = subjectBounds.maxX - subjectBounds.minX;
  const subjectHeight = subjectBounds.maxY - subjectBounds.minY;
  if (subjectWidth < 10 || subjectHeight < 10) return;

  // 차체 루프 라인 추정: 상단 25% 영역에서 가로 폭이 넓어지는 지점
  const roofScanYEnd = subjectBounds.minY + subjectHeight * 0.35;
  let estimatedRoofY = subjectBounds.minY;

  for (let y = subjectBounds.minY; y <= roofScanYEnd; y += 2) {
    let rowWidth = 0;
    let firstX = -1;
    let lastX = -1;
    for (let x = subjectBounds.minX; x <= subjectBounds.maxX; x += 2) {
      if (pixels[(y * width + x) * 4 + 3] > 120) {
        if (firstX < 0) firstX = x;
        lastX = x;
      }
    }
    if (firstX >= 0 && lastX >= firstX) {
      rowWidth = lastX - firstX + 1;
      // 가로 폭이 차체 폭의 40% 이상 넓어지면 실제 차체 루프라인으로 판단
      if (rowWidth > subjectWidth * 0.4) {
        estimatedRoofY = y;
        break;
      }
    }
  }

  // 추정된 루프라인보다 위쪽에 위치하면서, 폭이 좁은 독립 구조물('En' 등) 제거
  for (let y = 0; y < estimatedRoofY; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (pixels[idx + 3] > 50) {
        // 수평 연속 폭 확인
        let leftX = x, rightX = x;
        while (leftX > 0 && pixels[(y * width + leftX - 1) * 4 + 3] > 50) leftX--;
        while (rightX < width - 1 && pixels[(y * width + rightX + 1) * 4 + 3] > 50) rightX++;
        const componentWidth = rightX - leftX + 1;
        // 폭이 차체 폭의 30%보다 좁은 상단 노이즈 제거
        if (componentWidth < subjectWidth * 0.3) {
          pixels[idx + 3] = 0;
        }
      }
    }
  }
}

/**
 * 차량 마스크 하단부에서 촬영장 바닥 잔여물을 제거합니다.
 * - 턴테이블 곡선 조각: 차체 양측 밖으로 뻗은 얇은 구조
 * - 벽-바닥 경계선: 수평으로 길고 수직 두께가 얇은 구조
 * - 타이어와 차체 본체는 보호
 */
function removeFloorArtifacts(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  subjectBounds: { minX: number; maxX: number; minY: number; maxY: number },
): void {
  const subjectWidth = subjectBounds.maxX - subjectBounds.minX;
  const subjectHeight = subjectBounds.maxY - subjectBounds.minY;
  if (subjectWidth < 10 || subjectHeight < 10) return;

  // 차체 본체 영역 (좌우 15% 안쪽, 상하 보호)
  const bodyLeft = subjectBounds.minX + subjectWidth * 0.12;
  const bodyRight = subjectBounds.maxX - subjectWidth * 0.12;
  // 하단 30% 영역만 검사 (바닥 잔여물이 있는 곳)
  const scanTop = subjectBounds.maxY - subjectHeight * 0.32;
  // 타이어 보호 영역: 차체 폭의 15~85% 범위, 하단 근처
  const tireLeftZone = subjectBounds.minX + subjectWidth * 0.08;
  const tireRightZone = subjectBounds.maxX - subjectWidth * 0.08;
  const tireTopZone = subjectBounds.maxY - subjectHeight * 0.18;

  // 1단계: 각 열(column)에서 하단부의 불투명 수직 연속 길이 측정
  const thicknessThreshold = Math.max(6, subjectHeight * 0.05);

  for (let x = 0; x < width; x++) {
    const inBodyRange = x >= bodyLeft && x <= bodyRight;
    const inTireZone = x >= tireLeftZone && x <= tireRightZone;

    let runStart = -1;
    let runLength = 0;

    for (let y = height - 1; y >= Math.max(0, Math.floor(scanTop)); y--) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha > 80) {
        if (runStart < 0) runStart = y;
        runLength++;
      } else {
        if (runLength > 0 && runLength < thicknessThreshold) {
          if (inBodyRange && inTireZone && runStart >= tireTopZone) {
            // 타이어 접지부 보호
          } else if (!inBodyRange || runLength < thicknessThreshold * 0.6) {
            for (let ry = runStart; ry > runStart - runLength; ry--) {
              if (ry >= 0 && ry < height) {
                const offset = (ry * width + x) * 4;
                const distFromEdge = Math.min(ry - (runStart - runLength), runStart - ry);
                const fade = Math.min(1, distFromEdge / 2);
                pixels[offset + 3] = Math.round(pixels[offset + 3] * (1 - fade));
              }
            }
          }
        }
        runStart = -1;
        runLength = 0;
      }
    }
  }

  // 2단계: 수평 경계선 감지 및 제거
  for (let y = Math.max(0, Math.floor(scanTop)); y < height; y++) {
    let horizontalRun = 0;
    let runStartX = -1;

    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 80) {
        if (runStartX < 0) runStartX = x;
        horizontalRun++;
      } else {
        if (horizontalRun > subjectWidth * 0.85) {
          let verticalThickness = 0;
          for (let vy = Math.max(0, y - 8); vy <= Math.min(height - 1, y + 8); vy++) {
            const midX = Math.floor((runStartX + x) / 2);
            if (pixels[(vy * width + midX) * 4 + 3] > 80) verticalThickness++;
          }
          if (verticalThickness < 10) {
            for (let rx = runStartX; rx < x; rx++) {
              const inTire = rx >= tireLeftZone && rx <= tireRightZone && y >= tireTopZone;
              if (inTire) continue;
              for (let vy = Math.max(0, y - 2); vy <= Math.min(height - 1, y + 2); vy++) {
                const offset = (vy * width + rx) * 4;
                if (pixels[offset + 3] > 80) {
                  pixels[offset + 3] = 0;
                }
              }
            }
          }
        }
        horizontalRun = 0;
        runStartX = -1;
      }
    }
  }
}

async function refineCutout(blob: Blob): Promise<Blob> {
  const source = URL.createObjectURL(blob);
  try {
    const image = await loadImage(source);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return blob;
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    const original = new Uint8ClampedArray(pixels);
    const width = canvas.width;
    const height = canvas.height;
    const component = largestAlphaComponent(original, width, height);
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        if (original[(y * width + x) * 4 + 3] < 180) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const subjectWidth = Math.max(1, maxX - minX);
    const subjectHeight = Math.max(1, maxY - minY);
    const cleanupLeft = minX - subjectWidth * 0.12;
    const cleanupRight = maxX + subjectWidth * 0.12;
    const cleanupTop = minY - subjectHeight * 0.12;
    const cleanupBottom = maxY + subjectHeight * 0.12;

    // 모델이 만든 알파 매트를 보수적으로 정리한다. 차량 내부를 임의로
    // 불투명하게 만들거나 하단을 형태 규칙으로 잘라내면 창문·휠·범퍼가
    // 손상되므로, 가장 큰 연결 성분과 실제 알파 신뢰도만 사용한다.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const alpha = original[offset + 3];
        const componentIndex = Math.floor(y / component.step) * component.gridWidth + Math.floor(x / component.step);

        if (!component.keep[componentIndex]) {
          pixels[offset + 3] = 0;
          continue;
        }
        if (x < cleanupLeft || x > cleanupRight || y < cleanupTop || y > cleanupBottom) {
          pixels[offset + 3] = 0;
          continue;
        }
        if (alpha <= 18) {
          pixels[offset + 3] = 0;
          continue;
        }
        if (alpha >= 244) {
          pixels[offset + 3] = 255;
          continue;
        }

        let solidNeighbors = 0;
        let bestOffset = offset;
        let bestAlpha = alpha;
        const neighborhoodAlpha: number[] = [];
        for (let dy = -2; dy <= 2; dy += 1) {
          const sampleY = y + dy;
          if (sampleY < 0 || sampleY >= height) continue;
          for (let dx = -2; dx <= 2; dx += 1) {
            const sampleX = x + dx;
            if (sampleX < 0 || sampleX >= width) continue;
            const sampleOffset = (sampleY * width + sampleX) * 4;
            const sampleAlpha = original[sampleOffset + 3];
            neighborhoodAlpha.push(sampleAlpha);
            if (sampleAlpha > 128) solidNeighbors += 1;
            if (sampleAlpha > bestAlpha) {
              bestAlpha = sampleAlpha;
              bestOffset = sampleOffset;
            }
          }
        }
        if (solidNeighbors < 3) {
          pixels[offset + 3] = 0;
          continue;
        }

        neighborhoodAlpha.sort((a, b) => a - b);
        const medianAlpha = neighborhoodAlpha[Math.floor(neighborhoodAlpha.length / 2)] ?? alpha;
        // 낮은 알파의 벽색 프린지를 줄이되 얇은 안테나·미러·휠 스포크는
        // 중앙값과 원본 알파 중 높은 값을 사용해 보존한다.
        const matteAlpha = Math.max(alpha * 0.72, medianAlpha);
        const normalized = Math.max(0, Math.min(1, (matteAlpha - 38) / 188));
        const smoothAlpha = normalized * normalized * (3 - 2 * normalized);
        pixels[offset + 3] = Math.round(smoothAlpha * 255);
        const decontaminate = (1 - smoothAlpha) * Math.min(1, bestAlpha / 210) * 0.88;
        pixels[offset] = Math.round(original[offset] * (1 - decontaminate) + original[bestOffset] * decontaminate);
        pixels[offset + 1] = Math.round(original[offset + 1] * (1 - decontaminate) + original[bestOffset + 1] * decontaminate);
        pixels[offset + 2] = Math.round(original[offset + 2] * (1 - decontaminate) + original[bestOffset + 2] * decontaminate);
      }
    }

    context.putImageData(imageData, 0, 0);
    return await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result ?? blob), "image/png"));
  } finally {
    URL.revokeObjectURL(source);
  }
}

function drawStudioBackdrop(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  backdrop: Backdrop,
) {
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

  const glow = context.createRadialGradient(width * 0.5, height * 0.4, 0, width * 0.5, height * 0.4, width * 0.58);
  glow.addColorStop(0, backdrop === "graphite" ? "rgba(255,255,255,.17)" : "rgba(255,255,255,.9)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
}

function restoreOriginalFloor(
  context: CanvasRenderingContext2D,
  source: HTMLImageElement,
  width: number,
  height: number,
  horizonRatio: number,
) {
  const floorCanvas = document.createElement("canvas");
  floorCanvas.width = width;
  floorCanvas.height = height;
  const floorContext = floorCanvas.getContext("2d");
  if (!floorContext) return;

  floorContext.drawImage(source, 0, 0, width, height);
  const horizon = height * horizonRatio;
  const feather = height * 0.025;
  const mask = floorContext.createLinearGradient(0, horizon - feather, 0, horizon + feather);
  mask.addColorStop(0, "rgba(0,0,0,0)");
  mask.addColorStop(0.48, "rgba(0,0,0,.08)");
  mask.addColorStop(1, "rgba(0,0,0,1)");
  floorContext.globalCompositeOperation = "destination-in";
  floorContext.fillStyle = mask;
  floorContext.fillRect(0, horizon - feather, width, height - horizon + feather);
  floorContext.globalCompositeOperation = "source-over";
  context.drawImage(floorCanvas, 0, 0);
}

function blendWallOnly(
  context: CanvasRenderingContext2D,
  replacement: HTMLCanvasElement,
  foreground: HTMLImageElement,
  width: number,
  height: number,
  horizonRatio: number,
) {
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!maskContext) return;
  maskContext.drawImage(foreground, 0, 0, width, height);
  const foregroundPixels = maskContext.getImageData(0, 0, width, height).data;
  const sourceAlpha = new Uint8Array(width * height);
  for (let index = 0; index < sourceAlpha.length; index += 1) sourceAlpha[index] = foregroundPixels[index * 4 + 3];

  // 차량 경계 주변을 몇 픽셀 넓게 보호해 흰색/회색 벽색이 차체 외곽으로
  // 파고드는 현상을 막는다. 두 번의 1차원 최대값 필터로 빠르게 팽창한다.
  const radius = Math.max(2, Math.round(Math.max(width, height) / 720));
  const horizontal = new Uint8Array(sourceAlpha.length);
  const protectedAlpha = new Uint8Array(sourceAlpha.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let maximum = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sampleX = x + dx;
        if (sampleX >= 0 && sampleX < width) maximum = Math.max(maximum, sourceAlpha[y * width + sampleX]);
      }
      horizontal[y * width + x] = maximum;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let maximum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sampleY = y + dy;
        if (sampleY >= 0 && sampleY < height) maximum = Math.max(maximum, horizontal[sampleY * width + x]);
      }
      protectedAlpha[y * width + x] = maximum;
    }
  }

  const horizon = height * horizonRatio;
  const transition = Math.max(18, height * 0.055);
  const wallMask = maskContext.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const floorProtection = Math.max(0, Math.min(1, (horizon - y) / transition));
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const confidence = Math.max(0, Math.min(1, (92 - protectedAlpha[index]) / 78));
      const smoothConfidence = confidence * confidence * (3 - 2 * confidence);
      const offset = index * 4;
      wallMask.data[offset] = 255;
      wallMask.data[offset + 1] = 255;
      wallMask.data[offset + 2] = 255;
      wallMask.data[offset + 3] = Math.round(255 * smoothConfidence * floorProtection);
    }
  }
  maskContext.putImageData(wallMask, 0, 0);

  const wallCanvas = document.createElement("canvas");
  wallCanvas.width = width;
  wallCanvas.height = height;
  const wallContext = wallCanvas.getContext("2d");
  if (!wallContext) return;
  wallContext.drawImage(replacement, 0, 0);
  wallContext.globalCompositeOperation = "destination-in";
  wallContext.drawImage(maskCanvas, 0, 0);
  wallContext.globalCompositeOperation = "source-over";
  context.drawImage(wallCanvas, 0, 0);
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function createTransparentWallStrip(image: HTMLImageElement) {
  const scale = Math.min(1, 2200 / image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let x = 0; x < canvas.width; x += 1) {
    let firstBlue = canvas.height;
    let lastBlue = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      const offset = (y * canvas.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      if (blue > red * 1.18 && blue > green * 1.03 && blue > 75) {
        firstBlue = Math.min(firstBlue, y);
        lastBlue = Math.max(lastBlue, y);
      }
    }
    for (let y = 0; y < canvas.height; y += 1) {
      const offset = (y * canvas.width + x) * 4;
      const outsideBand = lastBlue < 0 || y < firstBlue - 1 || y > lastBlue + 1;
      if (outsideBand) pixels[offset + 3] = 0;
    }
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function drawWallStrip(
  context: CanvasRenderingContext2D,
  strip: HTMLCanvasElement,
  width: number,
  height: number,
  placement: WallStripPlacement,
) {
  const drawWidth = width * placement.scale;
  const drawHeight = drawWidth * (strip.height / strip.width);
  context.drawImage(strip, width * placement.x - drawWidth / 2, height * placement.y - drawHeight / 2, drawWidth, drawHeight);
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [foregroundUrl, setForegroundUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<Backdrop>("studio");
  const [ratio, setRatio] = useState<Ratio>("original");
  const [platePoints, setPlatePoints] = useState<PlatePoint[]>([]);
  const [plateCoordinates, setPlateCoordinates] = useState<PlateCoordinates>("canvas");
  const [plateMode, setPlateMode] = useState(false);
  const [plateStatus, setPlateStatus] = useState<"idle" | "working" | "done" | "skipped" | "error">("idle");
  const [plateMessage, setPlateMessage] = useState("전면 번호판을 자동으로 찾거나 네 모서리를 직접 지정하세요.");
  const [draggingPlateHandle, setDraggingPlateHandle] = useState<number | null>(null);
  const [compare, setCompare] = useState(50);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [detectedScene, setDetectedScene] = useState<SceneKind | null>(null);
  const [draggingCompare, setDraggingCompare] = useState(false);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchPreviews, setBatchPreviews] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchStatus, setBatchStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [batchResults, setBatchResults] = useState<{ name: string; blob: Blob; plate: string; beforeUrl: string; afterUrl: string }[]>([]);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [wallStripEnabled, setWallStripEnabled] = useState(true);
  const [wallStrip, setWallStrip] = useState<WallStripPlacement>({ x: 0.5, y: 0.14, scale: 1.04 });
  const [draggingWallStrip, setDraggingWallStrip] = useState(false);
  const [plateAction, setPlateAction] = useState<PlateAction>("replace");
  const [encarCleanup, setEncarCleanup] = useState<EncarCleanupOptions>({ stickerRemoval: true, glassReflection: true });
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [stageAspect, setStageAspect] = useState(16 / 9);
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const composeSequenceRef = useRef(0);

  function createTrackedUrl(blob: Blob) {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  }

  function releaseTrackedUrl(url: string | null) {
    if (!url || !objectUrlsRef.current.has(url)) return;
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!foregroundUrl) return;
    const sequence = ++composeSequenceRef.current;
    const timer = window.setTimeout(() => { void composeResult(foregroundUrl, sequence); }, 140);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foregroundUrl, backdrop, ratio, platePoints, plateCoordinates, wallStripEnabled, wallStrip, plateAction, encarCleanup]);

  async function composeImage(
    foreground: string,
    source: string,
    overlayPoints: PlatePoint[] = platePoints,
    overlayCoordinates: PlateCoordinates = plateCoordinates,
  ) {
    const [image, sourceImage] = await Promise.all([loadImage(foreground), loadImage(source)]);
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

    setDetectedScene("studio");
    const effectiveScene: SceneKind = "studio";
    const renderBackdrop: Backdrop = backdrop;
    const preserveFloor = ratio === "original" && sourceImage.width === image.width && sourceImage.height === image.height;
    const replacementCanvas = document.createElement("canvas");
    replacementCanvas.width = width;
    replacementCanvas.height = height;
    const replacementContext = replacementCanvas.getContext("2d");
    if (!replacementContext) throw new Error("스튜디오 배경을 만들지 못했습니다.");
    drawStudioBackdrop(replacementContext, width, height, backdrop);
    if (wallStripEnabled) {
      const stripSource = await loadImage("/autoinside-wall-strip.png");
      drawWallStrip(replacementContext, createTransparentWallStrip(stripSource), width, height, wallStrip);
    }
    if (preserveFloor) {
      const floorHorizon = estimateFloorHorizon(sourceImage, image);
      context.drawImage(sourceImage, 0, 0, width, height);
      blendWallOnly(context, replacementCanvas, image, width, height, floorHorizon);
    } else {
      context.drawImage(replacementCanvas, 0, 0);
    }

    const bounds = getSubjectBounds(image);
    let drawWidth: number;
    let drawHeight: number;
    let drawX: number;
    let drawY: number;
    let floorY: number;
    if (ratio === "original") {
      const originalScale = width / image.width;
      drawWidth = bounds.width * originalScale;
      drawHeight = bounds.height * originalScale;
      drawX = bounds.x * originalScale;
      drawY = bounds.y * originalScale;
      floorY = drawY + drawHeight;
    } else {
      const maxVehicleWidth = width * 0.66;
      const maxVehicleHeight = height * 0.59;
      const vehicleScale = Math.min(maxVehicleWidth / bounds.width, maxVehicleHeight / bounds.height);
      drawWidth = bounds.width * vehicleScale;
      drawHeight = bounds.height * vehicleScale;
      drawX = (width - drawWidth) / 2;
      floorY = height * 0.85;
      drawY = floorY - drawHeight;
    }
    const bottomProfile = getBottomProfile(image, bounds);
    if (!preserveFloor) {
      drawProjectedShadow(
        context,
        image,
        bounds,
        drawX,
        drawY,
        drawWidth,
        drawHeight,
        floorY,
        width,
        height,
        renderBackdrop,
      );
    }

    if (!preserveFloor && bottomProfile.length > 1) {
      const first = bottomProfile[0];
      context.save();
      context.filter = `blur(${Math.max(1.5, width * 0.0012)}px)`;
      context.fillStyle = renderBackdrop === "graphite" ? "rgba(0,0,0,.48)" : "rgba(8,11,13,.34)";
      context.beginPath();
      context.moveTo(drawX + drawWidth * first.x, drawY + drawHeight * first.y);
      for (const point of bottomProfile.slice(1)) {
        context.lineTo(drawX + drawWidth * point.x, drawY + drawHeight * point.y);
      }
      for (const point of [...bottomProfile].reverse()) {
        context.lineTo(
          drawX + drawWidth * point.x,
          drawY + drawHeight * point.y + Math.max(3, height * 0.006),
        );
      }
      context.closePath();
      context.fill();
      context.restore();
    }

    if (!preserveFloor) {
      context.save();
      context.filter = renderBackdrop === "graphite"
        ? "drop-shadow(0 2px 2px rgba(0,0,0,.38)) brightness(1.05) contrast(1.025) saturate(.96)"
        : "drop-shadow(0 2px 2px rgba(0,0,0,.2)) brightness(1.015) contrast(1.025) saturate(.95)";
      context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, drawX, drawY, drawWidth, drawHeight);
      context.restore();
    }

    const renderedPlatePoints = overlayPoints.length === 4 ? overlayPoints.map((point) => overlayCoordinates === "canvas" ? {
      x: point.x * width,
      y: point.y * height,
    } : {
      x: drawX + ((point.x * image.width - bounds.x) / bounds.width) * drawWidth,
      y: drawY + ((point.y * image.height - bounds.y) / bounds.height) * drawHeight,
    }) : [];

    // 번호판 처리: plateAction에 따라 교체 또는 블랭킹
    if (renderedPlatePoints.length === 4) {
      if (plateAction === "replace") {
        const logo = await loadImage("/autoinside-plate-logo.png");
        drawPerspectivePlate(context, logo, renderedPlatePoints);
      } else if (plateAction === "blank") {
        blankPlateRegion(context, renderedPlatePoints, width, height);
      }
    }

    // 엔카 브랜딩 제거
    const cleanupMessages: string[] = [];
    if (encarCleanup.stickerRemoval || encarCleanup.glassReflection) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
      if (maskContext) {
        maskContext.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, drawX, drawY, drawWidth, drawHeight);
        const foregroundMaskData = maskContext.getImageData(0, 0, width, height).data;

        if (encarCleanup.stickerRemoval) {
          const stickerCanvas = document.createElement("canvas");
          stickerCanvas.width = width;
          stickerCanvas.height = height;
          const stickerContext = stickerCanvas.getContext("2d", { willReadFrequently: true });
          if (stickerContext) {
            stickerContext.drawImage(sourceImage, 0, 0, width, height);
            const stickerResult = removeDisplayStickers(stickerContext, foregroundMaskData, width, height);
            if (stickerResult.removed > 0 || stickerResult.uncertain > 0) {
              cleanupMessages.push(stickerResult.message);
            }
          }
        }

        if (encarCleanup.glassReflection) {
          const glassResult = removeGlassReflections(context, foregroundMaskData, width, height);
          if (glassResult.removed > 0 || glassResult.uncertain > 0) {
            cleanupMessages.push(glassResult.message);
          }
        }
      }
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    if (!blob) throw new Error("결과 이미지를 만들지 못했습니다.");
    return {
      blob,
      renderedPlatePoints: renderedPlatePoints.map((point) => ({ x: point.x / width, y: point.y / height })),
      cleanupMessages,
    };

  }

  async function composeResult(foreground: string, sequence = ++composeSequenceRef.current) {
    const composed = await composeImage(foreground, sourceUrl);
    if (sequence !== composeSequenceRef.current) return;
    if (plateCoordinates === "source" && composed.renderedPlatePoints.length === 4) {
      setPlateCoordinates("canvas");
      setPlatePoints(composed.renderedPlatePoints);
    }
    if (composed.cleanupMessages?.length) {
      setCleanupMessage(composed.cleanupMessages.join(" · "));
    } else {
      setCleanupMessage("");
    }
    const nextUrl = createTrackedUrl(composed.blob);
    setResultUrl((old) => {
      if (sequence !== composeSequenceRef.current) return old;
      releaseTrackedUrl(old);
      return nextUrl;
    });
  }

  async function removeVehicleBackground(source: string, onProgress?: (value: number) => void) {
    const response = await fetch(source);
    const sourceBlob = await response.blob();
    const { removeBackground } = await import("@imgly/background-removal");
    const cutout = await removeBackground(sourceBlob, {
      publicPath: "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/",
      model: "isnet_fp16",
      device: "gpu",
      proxyToWorker: false,
      fetchArgs: { cache: "force-cache" },
      output: { format: "image/png", quality: 1, type: "foreground" },
      progress: (_key: string, current: number, total: number) => {
        if (total > 0) onProgress?.(Math.round((current / total) * 100));
      },
    });
    return refineCutout(cutout);
  }

  function acceptFile(file?: File) {
    if (!file || !file.type.startsWith("image/")) return;
    const next = createTrackedUrl(file);
    setSourceUrl((old) => {
      releaseTrackedUrl(old);
      return next;
    });
    setSourceName(file.name);
    setForegroundUrl((old) => {
      releaseTrackedUrl(old);
      return null;
    });
    setResultUrl((old) => {
      releaseTrackedUrl(old);
      return null;
    });
    setPlatePoints([]);
    setPlateCoordinates("canvas");
    setPlateMode(false);
    setPlateStatus("idle");
    setPlateMessage("전면 번호판을 자동으로 찾거나 네 모서리를 직접 지정하세요.");
    setStatus("idle");
    setDetectedScene(null);
    setProgress(0);
    setError("");
  }

  async function runAi() {
    if (!sourceUrl) return;
    setStatus("working");
    setError("");
    setProgress(4);
    try {
      const cutout = await removeVehicleBackground(sourceUrl, (value) => setProgress(Math.max(6, Math.min(90, Math.round(value * 0.9)))));
      setProgress(94);
      try {
        const sourceImage = await loadImage(sourceUrl);
        const detection = await detectFrontPlate(sourceImage);
        setPlateStatus(detection.points.length === 4 && detection.type !== "rear" ? "done" : "skipped");
        setPlateMessage(detection.message);
        setPlateCoordinates("source");
        setPlatePoints(detection.points.length === 4 && detection.type !== "rear"
          ? detection.points.map((point) => ({ x: point.x / sourceImage.naturalWidth, y: point.y / sourceImage.naturalHeight }))
          : []);
        if (detection.type === "rear") {
          setPlatePoints([]);
          setPlateStatus("skipped");
          setPlateMessage("후면 번호판은 원본을 유지합니다.");
        } else if (detection.points.length !== 4) {
          setPlatePoints([]);
          setPlateStatus("skipped");
          setPlateMessage("번호판을 확실히 검출하지 못했습니다. 자동 합성하지 않고 검수 대상으로 남겼습니다.");
        }
      } catch {
        setPlatePoints([]);
        setPlateStatus("skipped");
        setPlateMessage("번호판 검출 오류로 자동 합성하지 않았습니다. 직접 지정 기능을 사용해 주세요.");
      }
      const nextUrl = createTrackedUrl(cutout);
      setForegroundUrl((old) => {
        releaseTrackedUrl(old);
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
    const point = {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
    setPlatePoints((current) => current.length >= 4 ? [point] : [...current, point]);
    setPlateMessage(platePoints.length >= 3 ? "번호판 영역을 적용했습니다. 모서리를 드래그해 조정할 수 있습니다." : `${platePoints.length + 1}/4 지점 지정됨`);
    if (platePoints.length >= 3) setPlateMode(false);
  }

  async function runBatch() {
    if (!batchFiles.length) return;
    setBatchStatus("working");
    setBatchResults([]);
    setBatchProgress(0);
    const completed: { name: string; blob: Blob; plate: string; beforeUrl: string; afterUrl: string }[] = [];
    try {
      for (let index = 0; index < batchFiles.length; index += 1) {
        const file = batchFiles[index];
        const source = URL.createObjectURL(file);
        try {
          const cutoutBlob = await removeVehicleBackground(source, (value) => {
            setBatchProgress(Math.round(((index + value / 100) / batchFiles.length) * 100));
          });
          const cutoutUrl = URL.createObjectURL(cutoutBlob);
          try {
            const sourceImage = await loadImage(source);
            let points: PlatePoint[] = [];
            let plate = "번호판 미적용";
            try {
              const detection = await detectFrontPlate(sourceImage);
              plate = detection.message;
              if (detection.points.length === 4 && detection.type !== "rear") {
                points = detection.points.map((point) => ({ x: point.x / sourceImage.naturalWidth, y: point.y / sourceImage.naturalHeight }));
              } else if (detection.type !== "rear") {
                plate = "번호판 미검출 · 자동 합성 안 함 · 검수 필요";
              }
            } catch {
              plate = "번호판 검출 오류 · 자동 합성 안 함 · 검수 필요";
            }
            const composed = await composeImage(cutoutUrl, source, points, "source");
            const blob = composed.blob;
            completed.push({
              name: `${file.name.replace(/\.[^.]+$/, "")}-studio.jpg`,
              blob,
              plate,
              beforeUrl: batchPreviews[index] ?? createTrackedUrl(file),
              afterUrl: createTrackedUrl(blob),
            });
            setBatchResults([...completed]);
          } finally {
            URL.revokeObjectURL(cutoutUrl);
          }
        } finally {
          URL.revokeObjectURL(source);
        }
      }
      setBatchProgress(100);
      setBatchStatus("done");
    } catch (cause) {
      console.error(cause);
      setBatchStatus("error");
    }
  }

  async function downloadBatch() {
    if (!batchResults.length) return;
    const archive = new JSZip();
    batchResults.forEach((result) => archive.file(result.name, result.blob));
    archive.file("처리결과.txt", batchResults.map((result) => `${result.name}\t${result.plate}`).join("\n"));
    const blob = await archive.generateAsync({ type: "blob" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `car-studio-results-${Date.now()}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function acceptFiles(files?: FileList | File[]) {
    const images = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setBatchFiles(images);
    setBatchPreviews(images.map((file) => createTrackedUrl(file)));
    setBatchResults([]);
    setBatchStatus("idle");
    setBatchProgress(0);
    setDetailIndex(null);
    acceptFile(images[0]);
  }

  function downloadBatchItem(index: number) {
    const result = batchResults[index];
    if (!result) return;
    const link = document.createElement("a");
    link.href = result.afterUrl;
    link.download = result.name;
    link.click();
  }

  async function runPlateAi() {
    if (!sourceUrl) return;
    setPlateStatus("working");
    setPlateMode(false);
    setPlateMessage("번호판 AI 모델을 준비하고 있습니다. 첫 실행은 조금 걸릴 수 있습니다.");
    try {
      const source = await loadImage(sourceUrl);
      const detection: PlateDetection = await detectFrontPlate(source);
      setPlateStatus(detection.points.length === 4 && detection.type !== "rear" ? "done" : "skipped");
      setPlateMessage(detection.message);
      if (detection.points.length === 4 && detection.type !== "rear") {
        setPlateCoordinates("source");
        setPlatePoints(detection.points.map((point) => ({ x: point.x / source.naturalWidth, y: point.y / source.naturalHeight })));
      } else if (detection.type !== "rear") {
        setPlatePoints([]);
        setPlateStatus("skipped");
        setPlateMessage("번호판을 확실히 검출하지 못해 자동 합성하지 않았습니다. 직접 지정해 주세요.");
      } else {
        setPlatePoints([]);
        setPlateStatus("skipped");
        setPlateMessage("후면 번호판은 원본을 유지합니다.");
      }
    } catch (cause) {
      console.error(cause);
      setPlateStatus("error");
      setPlateMessage("번호판 AI를 불러오지 못했습니다. 직접 지정 기능은 계속 사용할 수 있습니다.");
    }
  }

  function startManualPlate() {
    setPlatePoints([]);
    setPlateCoordinates("canvas");
    setPlateMode(true);
    setPlateStatus("idle");
    setPlateMessage("번호판의 좌상단 → 우상단 → 우하단 → 좌하단 순서로 선택하세요.");
  }

  function updatePlateHandle(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    event.preventDefault();
    event.stopPropagation();
    const stage = event.currentTarget.closest(".image-stage") as HTMLDivElement | null;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const next = {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
    setPlatePoints((current) => current.map((point, pointIndex) => pointIndex === index ? next : point));
  }

  function downloadResult() {
    if (!resultUrl) return;
    const link = document.createElement("a");
    link.href = resultUrl;
    link.download = `${sourceName.replace(/\.[^.]+$/, "")}-studio.jpg`;
    link.click();
  }

  function updateCompareFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setCompare(Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)));
  }

  function startCompareDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resultUrl || plateMode || draggingPlateHandle !== null || draggingWallStrip) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingCompare(true);
    updateCompareFromPointer(event);
  }

  function moveCompareDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingCompare || !resultUrl) return;
    updateCompareFromPointer(event);
  }

  function moveWallStrip(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingWallStrip) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setWallStrip((current) => ({
      ...current,
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0.04, Math.min(0.45, (event.clientY - bounds.top) / bounds.height)),
    }));
  }

  function handleBrokenResult() {
    if (!resultUrl) return;
    setResultUrl((old) => {
      releaseTrackedUrl(old);
      return null;
    });
    setStatus("error");
    setError("결과 이미지를 표시하지 못했습니다. 다시 시도하거나 페이지를 새로고침해 주세요.");
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
        <p className="hero-copy">촬영장의 흰색·회색·검은색 벽면만 정돈하고 차량, 바닥과 실제 그림자는 그대로 유지합니다.</p>
      </section>

      <section className="workspace" onDragOver={(event: DragEvent) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); acceptFiles(event.dataTransfer.files); }}>
        <aside className="controls">
          <div className="step-heading"><span>01</span><div><h2>차량 사진</h2><p>JPG, PNG · 최대 20MB 권장</p></div></div>
          <button className="upload-card" onClick={() => inputRef.current?.click()}>
            <span className="upload-icon">＋</span>
            <strong>사진 바꾸기</strong>
            <span>클릭하거나 파일을 끌어오세요</span>
          </button>
          <input ref={inputRef} hidden multiple type="file" accept="image/jpeg,image/png,image/webp" onChange={(event: ChangeEvent<HTMLInputElement>) => acceptFiles(event.target.files ?? undefined)} />
          {sourceUrl && <div className="file-row"><span className="file-thumb"><img src={sourceUrl} alt="선택한 차량" /></span><span><strong>{sourceName}</strong><small>원본 이미지 준비됨</small></span><b>✓</b></div>}

          {batchFiles.length > 1 && (
            <div className="batch-panel">
              <strong>{batchFiles.length}장 일괄 변환</strong>
              <p>배경 제거부터 촬영장 합성, 전면 번호판 판정까지 순서대로 처리합니다.</p>
              <button disabled={batchStatus === "working"} onClick={runBatch}>{batchStatus === "working" ? `처리 중 ${batchProgress}%` : "전체 사진 원클릭 변환"}</button>
              {batchStatus === "working" && <div className="batch-meter"><i style={{ width: `${batchProgress}%` }} /></div>}
              {batchStatus === "error" && <small>일부 사진 처리 중 오류가 발생했습니다. 완료된 결과는 내려받을 수 있습니다.</small>}
            </div>
          )}

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
          <label className="label">원본 환경</label>
          <div className="scene-fixed"><strong>촬영장 전용</strong><span>흰색·회색·검은색 벽면만 교체하고 바닥과 실제 그림자는 유지합니다.</span></div>
          <p className="scene-note">
            {detectedScene ? "촬영장 인식 완료 · 기존 바닥과 실제 그림자 유지" : "촬영장 벽면을 분석합니다"}
          </p>
          <div className="wall-strip-tools">
            <label className="wall-strip-toggle">
              <input type="checkbox" checked={wallStripEnabled} onChange={(event) => setWallStripEnabled(event.target.checked)} />
              <span><strong>Autoinside 벽면 띠 합성</strong><small>흰 배경을 제거하고 차량 뒤 벽면에 배치합니다.</small></span>
            </label>
            {wallStripEnabled && (
              <div className="wall-strip-sliders">
                <label><span>가로 위치</span><input aria-label="벽면 띠 가로 위치" type="range" min="0" max="100" value={wallStrip.x * 100} onChange={(event) => setWallStrip((current) => ({ ...current, x: Number(event.target.value) / 100 }))} /></label>
                <label><span>세로 위치</span><input aria-label="벽면 띠 세로 위치" type="range" min="4" max="45" value={wallStrip.y * 100} onChange={(event) => setWallStrip((current) => ({ ...current, y: Number(event.target.value) / 100 }))} /></label>
                <label><span>크기</span><input aria-label="벽면 띠 크기" type="range" min="55" max="150" value={wallStrip.scale * 100} onChange={(event) => setWallStrip((current) => ({ ...current, scale: Number(event.target.value) / 100 }))} /></label>
                <small>결과 화면의 파란 위치점을 드래그해도 이동합니다.</small>
              </div>
            )}
          </div>
          <div className="encar-cleanup-tools">
            <label className="label">엔카 브랜딩 정리 옵션</label>
            <div className="cleanup-checkboxes">
              <label className="cleanup-toggle">
                <input
                  type="checkbox"
                  checked={encarCleanup.stickerRemoval}
                  onChange={(e) => setEncarCleanup((prev) => ({ ...prev, stickerRemoval: e.target.checked }))}
                />
                <span><strong>전광판 스티커 제거</strong><small>촬영장 벽면의 엔카 로고/스티커 메움</small></span>
              </label>
              <label className="cleanup-toggle">
                <input
                  type="checkbox"
                  checked={encarCleanup.glassReflection}
                  onChange={(e) => setEncarCleanup((prev) => ({ ...prev, glassReflection: e.target.checked }))}
                />
                <span><strong>유리 반사 텍스트 제거</strong><small>유리창에 비친 엔카 텍스트 블렌딩</small></span>
              </label>
            </div>
          </div>
          <div className="plate-action-group">
            <label className="label">번호판 처리 방식</label>
            <div className="segments plate-mode-segments">
              <button className={plateAction === "replace" ? "active" : ""} onClick={() => setPlateAction("replace")}>오토인사이드 교체</button>
              <button className={plateAction === "blank" ? "active" : ""} onClick={() => setPlateAction("blank")}>번호판 지우기</button>
              <button className={plateAction === "none" ? "active" : ""} onClick={() => setPlateAction("none")}>원본 유지</button>
            </div>
          </div>
          <div className="plate-tools">
            <button className="plate-button" disabled={!resultUrl || plateStatus === "working"} onClick={runPlateAi}>
              <span>AI</span><span><strong>전면 번호판 자동 감지</strong><small>전면으로 확실할 때만 번호판 좌표 감지</small></span>
            </button>
            <button className={`plate-button ${plateMode ? "active" : ""}`} disabled={!resultUrl} onClick={startManualPlate}>
              <span>4P</span><span><strong>번호판 직접 지정</strong><small>{platePoints.length ? `${platePoints.length}/4 지점 지정됨` : "네 모서리를 순서대로 선택"}</small></span>
            </button>

            <p className={`plate-status ${plateStatus}`}>{plateMessage}</p>
            {cleanupMessage && <p className="cleanup-status-note">✨ {cleanupMessage}</p>}
            {platePoints.length === 4 && <button className="text-button" onClick={() => { setPlatePoints([]); setPlateStatus("idle"); setPlateMessage("번호판 처리를 해제했습니다."); }}>번호판 지정 해제</button>}
          </div>

          <button className="primary" disabled={!sourceUrl || status === "working"} onClick={runAi}>
            {status === "working" ? "배경 제거·촬영장 합성·번호판 판정 중…" : resultUrl ? "한 번에 다시 변환하기" : "한 번에 배경 날리고 변환"}
            <span>→</span>
          </button>
          {status === "working" && <div className="progress"><i style={{ width: `${progress}%` }} /><span>첫 실행은 AI 모델 준비로 조금 더 걸릴 수 있어요 · {progress}%</span></div>}
          {error && (
            <div className="error-box">
              <p className="error">{error}</p>
              <div className="error-actions">
                <button onClick={runAi}>다시 시도</button>
                <button onClick={() => window.location.reload()}>새로고침</button>
              </div>
            </div>
          )}
        </aside>

        <div className="stage-panel">
          <div className="stage-top">
            <div className="preview-heading">
              <span className="preview-step">03</span>
              <span><strong>미리보기</strong><small><i className="status-dot" />{resultUrl ? "변환 완료 · 슬라이더로 원본 비교" : "원본 준비됨 · 왼쪽에서 변환을 시작하세요"}</small></span>
            </div>
            <button className="download" disabled={!resultUrl} onClick={downloadResult}>↓ JPG 다운로드</button>
          </div>
          <div
            className={`image-stage ${plateMode ? "targeting" : ""} ${resultUrl ? "comparing" : ""} ${draggingCompare ? "dragging" : ""}`}
            style={{ aspectRatio: stageAspect }}
            onClick={placePlate}
            onPointerDown={startCompareDrag}
            onPointerMove={(event) => { moveCompareDrag(event); moveWallStrip(event); }}
            onPointerUp={() => { setDraggingCompare(false); setDraggingWallStrip(false); }}
            onPointerCancel={() => { setDraggingCompare(false); setDraggingWallStrip(false); }}
          >
            {sourceUrl && <img className="result-image" src={resultUrl ?? sourceUrl} alt={resultUrl ? "AI 스튜디오 변환 결과" : "변환 전 차량 원본"} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setStageAspect(image.naturalWidth / image.naturalHeight); }} onError={handleBrokenResult} />}
            {resultUrl && sourceUrl && <div className="original-layer" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}><img src={sourceUrl} alt="변환 전 원본 비교" /></div>}
            {resultUrl && <div className="compare-line" style={{ left: `${compare}%` }}><i>↔</i></div>}
            {resultUrl && wallStripEnabled && (
              <button
                className="wall-strip-anchor"
                aria-label="Autoinside 벽면 띠 위치 이동"
                style={{ left: `${wallStrip.x * 100}%`, top: `${wallStrip.y * 100}%` }}
                onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingCompare(false); setDraggingWallStrip(true); }}
                onPointerUp={() => setDraggingWallStrip(false)}
                onPointerCancel={() => setDraggingWallStrip(false)}
              >띠</button>
            )}
            {!sourceUrl && <button className="empty-stage" onClick={() => inputRef.current?.click()}><b>사진을 올려주세요</b><span>JPG, PNG 파일을 선택하거나 화면에 끌어오세요</span></button>}
            {sourceUrl && !resultUrl && status !== "working" && <div className="ready-badge"><b>READY</b><span>왼쪽 설정을 확인하고<br />AI 변환을 시작하세요</span></div>}
            {status === "working" && <div className="processing-overlay"><div className="scanner" /><strong>차량 윤곽을 찾고 있습니다</strong><span>창문, 휠, 그림자를 섬세하게 분리하는 중</span></div>}
            {resultUrl && platePoints.length === 4 && platePoints.map((point, index) => (
              <button
                key={index}
                className="plate-handle"
                aria-label={`번호판 모서리 ${index + 1}`}
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingPlateHandle(index); }}
                onPointerMove={(event) => { if (draggingPlateHandle === index) updatePlateHandle(event, index); }}
                onPointerUp={(event) => { updatePlateHandle(event, index); setDraggingPlateHandle(null); }}
                onPointerCancel={() => setDraggingPlateHandle(null)}
              />
            ))}
            {plateMode && <div className="plate-hint">번호판 네 모서리를 좌상단부터 시계 방향으로 선택하세요 · {platePoints.length}/4</div>}
          </div>
          {resultUrl && <div className="compare-control"><span>원본</span><input aria-label="원본과 결과 비교" type="range" min="0" max="100" value={compare} onChange={(event) => setCompare(Number(event.target.value))} /><span>AI 결과</span></div>}
          <div className="stage-footer"><span>원본 차량의 형태와 색상은 유지됩니다</span><span>{ratio === "original" ? "원본 비율" : ratio} · 고화질 JPG</span></div>
        </div>
      </section>

      {batchFiles.length > 1 && (
        <section className="batch-review" aria-label="여러 사진 변환 비교">
          <div className="batch-review-head">
            <div><p className="eyebrow">BATCH BEFORE &amp; AFTER</p><h2>사진별 비포·애프터</h2></div>
            <div className="batch-head-actions">
              <div className="batch-summary"><strong>{batchResults.length}</strong><span>/ {batchFiles.length}장 완료</span></div>
              <button className="batch-review-download" disabled={!batchResults.length} onClick={downloadBatch}>↓ 결과 ZIP 다운로드</button>
            </div>
          </div>
          <div className="batch-review-grid">
            {batchFiles.map((file, index) => {
              const result = batchResults[index];
              return (
                <article className="batch-card" key={`${file.name}-${index}`}>
                  <div className="batch-card-images">
                    <figure><span>BEFORE</span><img src={batchPreviews[index]} alt={`${file.name} 원본`} /></figure>
                    <figure className={!result ? "pending" : ""} onClick={() => result && setDetailIndex(index)}>
                      <span>AFTER</span>
                      {result ? <img src={result.afterUrl} alt={`${file.name} 변환 결과`} /> : <div className="batch-placeholder">{batchStatus === "working" ? "변환 대기 중" : "전체 사진 원클릭 변환을 눌러주세요"}</div>}
                    </figure>
                  </div>
                  <div className="batch-card-meta">
                    <strong>{file.name}</strong>
                    <div className="batch-card-status-col">
                      {result?.plate.includes("검수 필요") && <span className="review-badge">검수 필요</span>}
                      <small>{result?.plate ?? "원본 준비됨"}</small>
                    </div>
                    {result && <button onClick={() => setDetailIndex(index)}>상세보기</button>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {detailIndex !== null && batchResults[detailIndex] && (
        <div className="detail-viewer" role="dialog" aria-modal="true" aria-label="변환 결과 상세보기" onClick={() => setDetailIndex(null)}>
          <div className="detail-shell" onClick={(event) => event.stopPropagation()}>
            <div className="detail-toolbar">
              <div><strong>{batchResults[detailIndex].name}</strong><small>{detailIndex + 1} / {batchResults.length} · {batchResults[detailIndex].plate}</small></div>
              <div><button onClick={() => downloadBatchItem(detailIndex)}>↓ 다운로드</button><button aria-label="상세보기 닫기" onClick={() => setDetailIndex(null)}>×</button></div>
            </div>
            <div className="detail-images">
              <figure><span>BEFORE</span><img src={batchResults[detailIndex].beforeUrl} alt="변환 전 상세 이미지" /></figure>
              <figure><span>AFTER</span><img src={batchResults[detailIndex].afterUrl} alt="변환 결과 상세 이미지" /></figure>
            </div>
            <button className="detail-prev" aria-label="이전 결과" disabled={detailIndex === 0} onClick={() => setDetailIndex((current) => Math.max(0, (current ?? 0) - 1))}>‹</button>
            <button className="detail-next" aria-label="다음 결과" disabled={detailIndex >= batchResults.length - 1} onClick={() => setDetailIndex((current) => Math.min(batchResults.length - 1, (current ?? 0) + 1))}>›</button>
          </div>
        </div>
      )}

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
