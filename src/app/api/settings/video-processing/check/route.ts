import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import {
  isFfmpegAvailable,
  isTranscriptProviderAvailable,
  isWhisperAvailable,
} from "@/lib/video-processing";

export const GET = withAuthenticatedUser(async () => {
  return NextResponse.json({
    ffmpeg: isFfmpegAvailable(),
    whisper: isWhisperAvailable(),
    openai: isTranscriptProviderAvailable("openai"),
    gemini: isTranscriptProviderAvailable("gemini"),
  });
});
