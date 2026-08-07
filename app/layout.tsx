import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const imageUrl = host ? `${protocol}://${host}/og.png` : undefined;

  return {
    title: "CAR STUDIO AI — 차량 사진을 전시장처럼",
    description: "야외 차량 사진의 배경을 AI로 분리하고 판매용 스튜디오 사진으로 완성합니다.",
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "CAR STUDIO AI",
      description: "찍은 그대로, 전시장 사진처럼.",
      type: "website",
      images: imageUrl ? [{ url: imageUrl, width: 1536, height: 1024, alt: "CAR STUDIO AI 차량 사진 편집기" }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: "CAR STUDIO AI",
      description: "찍은 그대로, 전시장 사진처럼.",
      images: imageUrl ? [imageUrl] : undefined,
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
