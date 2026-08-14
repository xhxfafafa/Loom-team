"use client";

export async function openExternalUrl(url: string): Promise<void> {
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
