import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { isRunning, spawn } from "@/lib/captain/process-manager";
import { createMessage, getConversation } from "@/lib/db/captain";

export const POST = withOrgAuth(
  async (req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (isRunning(id)) {
      return NextResponse.json({ error: "A response is already in progress" }, { status: 409 });
    }

    const body = await req.json();
    const prompt = body.message?.trim();
    if (!prompt) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const userMessage = createMessage(id, "user", prompt);
    const assistantMessage = createMessage(id, "assistant", "");

    // Session ID generation is provider-aware and lives in spawn() — codex and
    // gemini must start with null and capture the CLI-minted ID from output.
    const isNewSession = !conversation.session_id;
    const sessionId = conversation.session_id;

    spawn({
      conversationId: id,
      messageId: assistantMessage.id,
      prompt,
      cli: conversation.cli,
      model: conversation.model,
      thinking: conversation.thinking,
      sessionId,
      isNewSession,
      cwd: conversation.cwd,
    }).catch(() => {
      // Error handling is done inside spawn's finally block
    });

    return NextResponse.json(
      { messageId: assistantMessage.id, userMessageId: userMessage.id },
      { status: 202 },
    );
  },
  { role: "editor" },
);
