"use client";

import { ChangeEvent, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { detectFrontPlate, drawPerspectivePlate, type PlateDetection, type PlatePoint } from "./plate-ai";
import JSZip from "jszip";

type Backdrop = "blue" | "studio" | "warm" | "graphite";
type Ratio = "original" | "16:9" | "4:3" | "1:1";
type SceneMode = "auto" | "studio" | "outdoor";
type SceneKind = Exclude<SceneMode, "auto">;
type PlateCoordinates = "source" | "canvas";
type WallStripPlacement = { x: number; y: number; scale: number };

const backdropNames: Record<Backdrop, string> = {
  blue: "블루 커브 스튜디오",
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

function detectScene(source: HTMLImageElement, foreground: HTMLImageElement): SceneKind {
  const analysisWidth = 360;
  const analysisHeight = Math.max(1, Math.round(analysisWidth * (source.height / source.width)));
  const sourceCanvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  sourceCanvas.width = maskCanvas.width = analysisWidth;
  sourceCanvas.height = maskCanvas.height = analysisHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext || !maskContext) return "outdoor";
  sourceContext.drawImage(source, 0, 0, analysisWidth, analysisHeight);
  maskContext.drawImage(foreground, 0, 0, analysisWidth, analysisHeight);
  const sourcePixels = sourceContext.getImageData(0, 0, analysisWidth, analysisHeight).data;
  const maskPixels = maskContext.getImageData(0, 0, analysisWidth, analysisHeight).data;
  let saturationTotal = 0;
  let greenPixels = 0;
  let textureTotal = 0;
  let samples = 0;

  for (let y = 2; y < analysisHeight * 0.62; y += 3) {
    for (let x = 2; x < analysisWidth - 3; x += 3) {
      const offset = (Math.floor(y) * analysisWidth + x) * 4;
      if (maskPixels[offset + 3] > 48) continue;
      const r = sourcePixels[offset];
      const g = sourcePixels[offset + 1];
      const b = sourcePixels[offset + 2];
      const maximum = Math.max(r, g, b);
      const minimum = Math.min(r, g, b);
      saturationTotal += maximum ? (maximum - minimum) / maximum : 0;
      if (g > r * 1.08 && g > b * 1.06 && g > 55) greenPixels += 1;
      const right = offset + 12;
      const below = offset + analysisWidth * 4 * 3;
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const rightLuminance = sourcePixels[right] * 0.2126 + sourcePixels[right + 1] * 0.7152 + sourcePixels[right + 2] * 0.0722;
      const belowLuminance = sourcePixels[below] * 0.2126 + sourcePixels[below + 1] * 0.7152 + sourcePixels[below + 2] * 0.0722;
      textureTotal += (Math.abs(luminance - rightLuminance) + Math.abs(luminance - belowLuminance)) / 2;
      samples += 1;
    }
  }

  if (samples < 80) return "outdoor";
  const saturation = saturationTotal / samples;
  const greenRatio = greenPixels / samples;
  const texture = textureTotal / samples;
  const outdoorScore = saturation * 2.1 + greenRatio * 1.6 + Math.max(0, texture - 8) / 24;
  return outdoorScore >= 0.72 ? "outdoor" : "studio";
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

function createStudioGradedVehicle(image: HTMLImageElement, bounds: SubjectBounds) {
  const scale = Math.min(1, 1200 / Math.max(bounds.width, bounds.height));
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const original = new Uint8ClampedArray(pixels);
  const radius = Math.max(10, Math.round(width * 0.028));
  const samples = [[-radius, 0], [radius, 0], [0, -radius], [0, radius], [-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]];

  for (let y = 0; y < height * 0.62; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (original[offset + 3] < 96) continue;
      const r = original[offset];
      const g = original[offset + 1];
      const b = original[offset + 2];
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (luminance < 224) continue;
      let ringLight = 0;
      let ringSamples = 0;
      for (const [dx, dy] of samples) {
        const sampleX = x + dx;
        const sampleY = y + dy;
        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) continue;
        const sampleOffset = (sampleY * width + sampleX) * 4;
        if (original[sampleOffset + 3] < 96) continue;
        ringLight += original[sampleOffset] * 0.2126 + original[sampleOffset + 1] * 0.7152 + original[sampleOffset + 2] * 0.0722;
        ringSamples += 1;
      }
      if (ringSamples < 3) continue;
      const neighborhood = ringLight / ringSamples;
      const excess = luminance - neighborhood;
      if (excess < 30) continue;
      const strength = Math.min(0.82, (excess - 30) / 85);
      const targetLight = Math.min(luminance, neighborhood + 24);
      const factor = (luminance * (1 - strength) + targetLight * strength) / luminance;
      pixels[offset] = Math.round(r * factor);
      pixels[offset + 1] = Math.round(g * factor);
      pixels[offset + 2] = Math.round(b * factor);
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
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

function drawDiffuseStudioShadow(
  context: CanvasRenderingContext2D,
  drawX: number,
  drawWidth: number,
  drawHeight: number,
  floorY: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const layers = [
    { x: 0.5, y: 0.018, radiusX: 0.39, radiusY: 0.025, blur: 0.0065, color: "rgba(28,31,34,.18)" },
    { x: 0.49, y: 0.034, radiusX: 0.31, radiusY: 0.013, blur: 0.0034, color: "rgba(18,21,23,.3)" },
    { x: 0.48, y: 0.044, radiusX: 0.235, radiusY: 0.0065, blur: 0.0018, color: "rgba(10,12,14,.38)" },
  ];

  for (const layer of layers) {
    context.save();
    context.filter = `blur(${Math.max(2, canvasWidth * layer.blur)}px)`;
    context.fillStyle = layer.color;
    context.beginPath();
    context.ellipse(
      drawX + drawWidth * layer.x,
      floorY - drawHeight * layer.y,
      drawWidth * layer.radiusX,
      Math.max(3, canvasHeight * layer.radiusY),
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
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

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const alpha = original[offset + 3];
        if (alpha <= 20) {
          pixels[offset + 3] = 0;
          continue;
        }
        if (alpha >= 245) continue;

        let solidNeighbors = 0;
        let bestOffset = offset;
        let bestAlpha = alpha;
        for (let dy = -2; dy <= 2; dy += 1) {
          const sampleY = y + dy;
          if (sampleY < 0 || sampleY >= height) continue;
          for (let dx = -2; dx <= 2; dx += 1) {
            const sampleX = x + dx;
            if (sampleX < 0 || sampleX >= width) continue;
            const sampleOffset = (sampleY * width + sampleX) * 4;
            const sampleAlpha = original[sampleOffset + 3];
            if (sampleAlpha > 96) solidNeighbors += 1;
            if (sampleAlpha > bestAlpha) {
              bestAlpha = sampleAlpha;
              bestOffset = sampleOffset;
            }
          }
        }
        if (solidNeighbors < 5) {
          pixels[offset + 3] = 0;
          continue;
        }

        const normalized = Math.max(0, Math.min(1, (alpha - 24) / 216));
        const smoothAlpha = normalized * normalized * (3 - 2 * normalized);
        pixels[offset + 3] = Math.round(smoothAlpha * 255);
        const decontaminate = (1 - smoothAlpha) * Math.min(1, bestAlpha / 220) * 0.72;
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
  brandLogo?: HTMLImageElement,
) {
  if (backdrop === "blue") {
    const wall = context.createLinearGradient(0, 0, 0, height);
    wall.addColorStop(0, "#f8f9fa");
    wall.addColorStop(0.58, "#e7eaed");
    wall.addColorStop(0.7, "#cfd4d8");
    wall.addColorStop(1, "#aeb5ba");
    context.fillStyle = wall;
    context.fillRect(0, 0, width, height);

    const wallGlow = context.createRadialGradient(width * 0.5, height * 0.38, 0, width * 0.5, height * 0.38, width * 0.62);
    wallGlow.addColorStop(0, "rgba(255,255,255,.98)");
    wallGlow.addColorStop(0.68, "rgba(255,255,255,.28)");
    wallGlow.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = wallGlow;
    context.fillRect(0, 0, width, height);

    const bandTop = height * 0.09;
    const bandBottom = height * 0.175;
    context.save();
    context.beginPath();
    context.moveTo(0, bandTop * 0.72);
    context.quadraticCurveTo(width * 0.5, bandTop * 1.34, width, bandTop * 0.72);
    context.lineTo(width, bandBottom * 0.86);
    context.quadraticCurveTo(width * 0.5, bandBottom * 1.12, 0, bandBottom * 0.86);
    context.closePath();
    const band = context.createLinearGradient(0, 0, width, 0);
    band.addColorStop(0, "#1559e8");
    band.addColorStop(0.5, "#3179ff");
    band.addColorStop(1, "#1559e8");
    context.fillStyle = band;
    context.shadowColor = "rgba(29,100,255,.35)";
    context.shadowBlur = Math.max(12, height * 0.018);
    context.fill();
    context.restore();

    if (brandLogo) {
      const logoWidth = width * 0.1;
      const logoHeight = logoWidth * (brandLogo.height / brandLogo.width);
      context.save();
      context.globalAlpha = 0.96;
      context.drawImage(brandLogo, width * 0.5 - logoWidth / 2, height * 0.025, logoWidth, logoHeight);
      context.restore();
    }

    const floor = context.createLinearGradient(0, height * 0.64, 0, height);
    floor.addColorStop(0, "rgba(255,255,255,0)");
    floor.addColorStop(0.18, "rgba(230,233,235,.8)");
    floor.addColorStop(1, "rgba(151,158,163,.82)");
    context.fillStyle = floor;
    context.fillRect(0, height * 0.62, width, height * 0.38);

    context.save();
    context.strokeStyle = "rgba(63,70,76,.34)";
    context.lineWidth = Math.max(1, width * 0.0014);
    context.beginPath();
    context.ellipse(width * 0.5, height * 0.835, width * 0.39, height * 0.12, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    return;
  }

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
  const feather = height * 0.018;
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
  const [sourceUrl, setSourceUrl] = useState("/sample-car.jpg");
  const [sourceName, setSourceName] = useState("RTC20250929100024473_0X.jpg");
  const [foregroundUrl, setForegroundUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<Backdrop>("blue");
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
  const [sceneMode, setSceneMode] = useState<SceneMode>("auto");
  const [detectedScene, setDetectedScene] = useState<SceneKind | null>(null);
  const [draggingCompare, setDraggingCompare] = useState(false);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchPreviews, setBatchPreviews] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchStatus, setBatchStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [batchResults, setBatchResults] = useState<{ name: string; blob: Blob; plate: string; beforeUrl: string; afterUrl: string }[]>([]);
  const [wallStripEnabled, setWallStripEnabled] = useState(true);
  const [wallStrip, setWallStrip] = useState<WallStripPlacement>({ x: 0.5, y: 0.14, scale: 1.04 });
  const [draggingWallStrip, setDraggingWallStrip] = useState(false);
  const [stageAspect, setStageAspect] = useState(16 / 9);
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());

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
    void composeResult(foregroundUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foregroundUrl, backdrop, ratio, platePoints, plateCoordinates, sceneMode, wallStripEnabled, wallStrip]);

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

    const detected = detectScene(sourceImage, image);
    setDetectedScene(detected);
    const effectiveScene = sceneMode === "auto" ? detected : sceneMode;
    const renderBackdrop: Backdrop = effectiveScene === "outdoor" ? "blue" : backdrop;
    if (effectiveScene === "outdoor") {
      const outdoorStudio = await loadImage("/autoinside-outdoor-studio.png");
      drawImageCover(context, outdoorStudio, width, height);
    } else {
      const brandLogo = backdrop === "blue" ? await loadImage("/autoinside-logo.png") : undefined;
      drawStudioBackdrop(context, width, height, backdrop, brandLogo);
    }
    if (wallStripEnabled) {
      const stripSource = await loadImage("/autoinside-wall-strip.png");
      drawWallStrip(context, createTransparentWallStrip(stripSource), width, height, wallStrip);
    }
    const preserveFloor = effectiveScene === "studio" && ratio === "original" && sourceImage.width === image.width && sourceImage.height === image.height;
    if (preserveFloor) {
      const floorHorizon = estimateFloorHorizon(sourceImage, image);
      restoreOriginalFloor(context, sourceImage, width, height, floorHorizon);
    }

    const bounds = getSubjectBounds(image);
    let drawWidth: number;
    let drawHeight: number;
    let drawX: number;
    let drawY: number;
    let floorY: number;
    if (effectiveScene === "outdoor") {
      const maxVehicleWidth = width * 0.64;
      const maxVehicleHeight = height * 0.54;
      const vehicleScale = Math.min(maxVehicleWidth / bounds.width, maxVehicleHeight / bounds.height);
      drawWidth = bounds.width * vehicleScale;
      drawHeight = bounds.height * vehicleScale;
      drawX = (width - drawWidth) / 2;
      floorY = height * 0.825;
      drawY = floorY - drawHeight;
    } else if (ratio === "original") {
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
      floorY = height * (renderBackdrop === "blue" ? 0.855 : 0.85);
      drawY = floorY - drawHeight;
    }
    const bottomProfile = getBottomProfile(image, bounds);
    const studioVehicle = effectiveScene === "outdoor" ? createStudioGradedVehicle(image, bounds) : null;

    if (!preserveFloor && effectiveScene === "outdoor") {
      drawDiffuseStudioShadow(context, drawX, drawWidth, drawHeight, floorY, width, height);
    } else if (!preserveFloor) {
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

    if (!preserveFloor && effectiveScene !== "outdoor" && bottomProfile.length > 1) {
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

    context.save();
    context.filter = effectiveScene === "outdoor"
      ? "drop-shadow(0 1px 1px rgba(0,0,0,.18)) brightness(1.07) contrast(.94) saturate(.86)"
      : renderBackdrop === "graphite"
        ? "drop-shadow(0 2px 2px rgba(0,0,0,.38)) brightness(1.05) contrast(1.025) saturate(.96)"
        : "drop-shadow(0 2px 2px rgba(0,0,0,.2)) brightness(1.015) contrast(1.025) saturate(.95)";
    if (studioVehicle) {
      context.drawImage(studioVehicle, 0, 0, studioVehicle.width, studioVehicle.height, drawX, drawY, drawWidth, drawHeight);
    } else {
      context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, drawX, drawY, drawWidth, drawHeight);
    }
    context.restore();

    const renderedPlatePoints = overlayPoints.length === 4 ? overlayPoints.map((point) => overlayCoordinates === "canvas" ? {
      x: point.x * width,
      y: point.y * height,
    } : {
      x: drawX + ((point.x * image.width - bounds.x) / bounds.width) * drawWidth,
      y: drawY + ((point.y * image.height - bounds.y) / bounds.height) * drawHeight,
    }) : [];
    if (renderedPlatePoints.length === 4) {
      const logo = await loadImage("/autoinside-plate-logo.png");
      drawPerspectivePlate(context, logo, renderedPlatePoints);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    if (!blob) throw new Error("결과 이미지를 만들지 못했습니다.");
    return {
      blob,
      renderedPlatePoints: renderedPlatePoints.map((point) => ({ x: point.x / width, y: point.y / height })),
    };
  }

  async function composeResult(foreground: string) {
    const composed = await composeImage(foreground, sourceUrl);
    if (plateCoordinates === "source" && composed.renderedPlatePoints.length === 4) {
      setPlateCoordinates("canvas");
      setPlatePoints(composed.renderedPlatePoints);
    }
    const nextUrl = createTrackedUrl(composed.blob);
    setResultUrl((old) => {
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
    setStatus("working");
    setError("");
    setProgress(4);
    try {
      const cutout = await removeVehicleBackground(sourceUrl, (value) => setProgress(Math.max(6, Math.min(90, Math.round(value * 0.9)))));
      setProgress(94);
      try {
        const sourceImage = await loadImage(sourceUrl);
        const detection = await detectFrontPlate(sourceImage);
        setPlateStatus(detection.points.length === 4 ? "done" : "skipped");
        setPlateMessage(detection.message);
        setPlateCoordinates("source");
        setPlatePoints(detection.points.length === 4
          ? detection.points.map((point) => ({ x: point.x / sourceImage.naturalWidth, y: point.y / sourceImage.naturalHeight }))
          : []);
        if (detection.points.length !== 4) {
          const width = sourceImage.naturalWidth;
          const height = sourceImage.naturalHeight;
          setPlateCoordinates("source");
          setPlatePoints([
            { x: 0.39, y: 0.66 },
            { x: 0.61, y: 0.66 },
            { x: 0.61, y: 0.74 },
            { x: 0.39, y: 0.74 },
          ]);
          setPlateStatus("skipped");
          setPlateMessage(`번호판 후보를 불러왔습니다. 파란 앵커를 실제 번호판 모서리에 맞춰 주세요. (${width}×${height})`);
        }
      } catch {
        setPlateCoordinates("source");
        setPlatePoints([
          { x: 0.39, y: 0.66 },
          { x: 0.61, y: 0.66 },
          { x: 0.61, y: 0.74 },
          { x: 0.39, y: 0.74 },
        ]);
        setPlateStatus("skipped");
        setPlateMessage("번호판 기본 영역을 불러왔습니다. 파란 앵커를 실제 번호판 모서리에 맞춰 주세요.");
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
              if (detection.points.length === 4) {
                points = detection.points.map((point) => ({ x: point.x / sourceImage.naturalWidth, y: point.y / sourceImage.naturalHeight }));
              }
            } catch {
              plate = "번호판 AI를 불러오지 못해 배경만 변환";
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
    acceptFile(images[0]);
  }

  async function runPlateAi() {
    setPlateStatus("working");
    setPlateMode(false);
    setPlateMessage("번호판 AI 모델을 준비하고 있습니다. 첫 실행은 조금 걸릴 수 있습니다.");
    try {
      const source = await loadImage(sourceUrl);
      const detection: PlateDetection = await detectFrontPlate(source);
      setPlateStatus(detection.points.length === 4 ? "done" : "skipped");
      setPlateMessage(detection.message);
      if (detection.points.length === 4) {
        setPlateCoordinates("source");
        setPlatePoints(detection.points.map((point) => ({ x: point.x / source.naturalWidth, y: point.y / source.naturalHeight })));
      } else {
        setPlatePoints([]);
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
        <p className="hero-copy">복잡한 야외 배경을 지우고 차량에 어울리는 빛과 공간을 더합니다. 별도 설치 없이 브라우저에서 바로 완성하세요.</p>
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
          <div className="file-row"><span className="file-thumb"><img src={sourceUrl} alt="선택한 차량" /></span><span><strong>{sourceName}</strong><small>원본 이미지 준비됨</small></span><b>✓</b></div>

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
          <div className="scene-modes">
            {(["auto", "studio"] as SceneMode[]).map((mode) => (
              <button key={mode} className={sceneMode === mode ? "active" : ""} onClick={() => setSceneMode(mode)}>
                {mode === "auto" ? "자동" : "촬영장"}
              </button>
            ))}
          </div>
          <p className="scene-note">
            {sceneMode === "auto"
              ? detectedScene
                ? `자동 인식: ${detectedScene === "studio" ? "촬영장 · 바닥 유지" : "야외 · 오토인사이드 촬영장 적용"}`
                : "AI 변환 시 촬영장과 야외를 자동으로 구분합니다"
              : "기존 바닥과 실제 그림자를 유지하고 벽만 교체합니다"}
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
          <div className="plate-tools">
          <button className="plate-button" disabled={!resultUrl || plateStatus === "working"} onClick={runPlateAi}>
            <span>AI</span><span><strong>전면 번호판 자동 교체</strong><small>전면으로 확실할 때만 Autoinside 번호판 적용</small></span>
          </button>
          <button className={`plate-button ${plateMode ? "active" : ""}`} disabled={!resultUrl} onClick={startManualPlate}>
            <span>4P</span><span><strong>번호판 직접 지정</strong><small>{platePoints.length ? `${platePoints.length}/4 지점 지정됨` : "네 모서리를 순서대로 선택"}</small></span>
          </button>

          <p className={`plate-status ${plateStatus}`}>{plateMessage}</p>
          {platePoints.length === 4 && <button className="text-button" onClick={() => { setPlatePoints([]); setPlateStatus("idle"); setPlateMessage("번호판 교체를 해제했습니다."); }}>번호판 교체 해제</button>}
          </div>

          <button className="primary" disabled={status === "working"} onClick={runAi}>
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
            <img className="result-image" src={resultUrl ?? sourceUrl} alt={resultUrl ? "AI 스튜디오 변환 결과" : "변환 전 차량 원본"} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setStageAspect(image.naturalWidth / image.naturalHeight); }} onError={handleBrokenResult} />
            {resultUrl && <div className="original-layer" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}><img src={sourceUrl} alt="변환 전 원본 비교" /></div>}
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
            {!resultUrl && status !== "working" && <div className="ready-badge"><b>READY</b><span>왼쪽 설정을 확인하고<br />AI 변환을 시작하세요</span></div>}
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
                    <figure className={!result ? "pending" : ""}>
                      <span>AFTER</span>
                      {result ? <img src={result.afterUrl} alt={`${file.name} 변환 결과`} /> : <div className="batch-placeholder">{batchStatus === "working" ? "변환 대기 중" : "전체 사진 원클릭 변환을 눌러주세요"}</div>}
                    </figure>
                  </div>
                  <div className="batch-card-meta"><strong>{file.name}</strong><small>{result?.plate ?? "원본 준비됨"}</small></div>
                </article>
              );
            })}
          </div>
        </section>
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
