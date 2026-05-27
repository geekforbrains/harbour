"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped } from "@/lib/api/client";
import { useScope } from "@/lib/hooks/use-project-filter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StreamingOutput, ToolCallList } from "@/components/app/captain-message";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  MessageSquare,
  Plus,
  Send,
  Square,
  PanelLeftOpen,
  PanelLeftClose,
  Trash2,
  User,
  Bot,
  Settings,
  List,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Conversation = {
  id: string;
  title: string;
  cli: string;
  model: string | null;
  thinking: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
};

type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  toolEvents: OutputEvent[];
};

type OutputEvent = {
  id: number;
  event_type: string;
  content: string | null;
  tool_name: string | null;
};

// ── Conversation Sidebar ──────────────────────────────────────────────

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3">
        <Button onClick={onNew} variant="outline" className="w-full justify-start gap-2" size="sm">
          <Plus className="h-4 w-4" /> New Chat
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors ${
              c.id === activeId
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
            onClick={() => onSelect(c.id)}
          >
            <MessageSquare className="h-3.5 w-3.5 mr-2 shrink-0" />
            <span className="truncate flex-1">{c.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              className="opacity-0 group-hover:opacity-100 ml-1 p-0.5 hover:text-destructive transition-opacity"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No conversations yet</p>
        )}
      </div>
    </div>
  );
}

// ── Chat View ──────────────────────────────────────────────────────────

function ChatView({
  conversationId,
  onTitleUpdate,
}: {
  conversationId: string;
  onTitleUpdate: (id: string, title: string) => void;
}) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamEvents, setStreamEvents] = useState<OutputEvent[]>([]);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const isFirstMessageRef = useRef(false);

  // Fetch conversation with messages
  const { data: conversation } = useQuery<{
    messages: Message[];
    title: string;
    cli: string;
    model: string | null;
  }>({
    queryKey: ["captain-conversation", conversationId],
    queryFn: () =>
      apiFetch<{
        messages: Message[];
        title: string;
        cli: string;
        model: string | null;
      }>(`/api/captain/conversations/${conversationId}`),
  });

  const connectStream = useCallback(
    (msgId?: string) => {
      eventSourceRef.current?.close();
      setStreamEvents([]);

      const params = new URLSearchParams({ after: "0" });
      if (msgId) params.set("messageId", msgId);
      const evtSource = new EventSource(
        `/api/captain/conversations/${conversationId}/stream?${params}`
      );
      eventSourceRef.current = evtSource;

      let lastId = 0;
      evtSource.addEventListener("output", (e) => {
        const evt = JSON.parse(e.data) as OutputEvent;
        if (evt.id <= lastId) return;
        lastId = evt.id;
        setStreamEvents((prev) => [...prev, evt]);
      });

      evtSource.addEventListener("done", () => {
        evtSource.close();
        eventSourceRef.current = null;
        setStreaming(false);
        setActiveMessageId(null);
        setStreamEvents([]);
        queryClient.invalidateQueries({
          queryKey: ["captain-conversation", conversationId],
        });
        if (isFirstMessageRef.current) {
          isFirstMessageRef.current = false;
        }
        setTimeout(() => textareaRef.current?.focus(), 100);
      });

      evtSource.onerror = () => {
        evtSource.close();
        eventSourceRef.current = null;
        setStreaming(false);
        setActiveMessageId(null);
      };
    },
    [conversationId, queryClient]
  );

  // Check if a response is already in-flight (e.g. after page refresh)
  useEffect(() => {
    let cancelled = false;
    async function checkStatus() {
      try {
        const data = await apiFetch<{ running?: boolean; activeMessageId?: string }>(
          `/api/captain/conversations/${conversationId}/status`
        );
        if (cancelled) return;
        if (data.running && data.activeMessageId) {
          setStreaming(true);
          setActiveMessageId(data.activeMessageId);
          connectStream(data.activeMessageId);
        }
      } catch { /* ignore */ }
    }
    checkStatus();
    return () => { cancelled = true; };
  }, [conversationId, connectStream]);

  // Cleanup EventSource on unmount or conversation switch
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [conversationId]);

  // Auto-scroll to bottom — use scrollTop on the container to avoid scrolling parent elements
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation?.messages, streamEvents]);

  // Send message
  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(
        `/api/captain/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to send message");
      }
      return res.json();
    },
    onSuccess: (data) => {
      // Check if this is the first message for auto-titling
      if (!conversation?.messages || conversation.messages.length === 0) {
        isFirstMessageRef.current = true;
        // Auto-title from first message
        const title = input.trim().slice(0, 80);
        onTitleUpdate(conversationId, title);
      }
      setInput("");
      setStreaming(true);
      setActiveMessageId(data.messageId);
      // Add user message optimistically
      queryClient.invalidateQueries({
        queryKey: ["captain-conversation", conversationId],
      });
      // Connect to stream
      connectStream(data.messageId);
    },
  });

  function handleSend() {
    const msg = input.trim();
    if (!msg || streaming) return;
    sendMutation.mutate(msg);
  }

  function handleStop() {
    apiFetch(`/api/captain/conversations/${conversationId}/stop`, {
      method: "POST",
    }).catch(() => {});
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const messages = conversation?.messages || [];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Messages area */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-4">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <MessageSquare className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">Send a message to get started</p>
            <p className="text-muted-foreground/60 text-xs mt-1">
              Using {conversation?.cli || "..."}{conversation?.model ? ` (${conversation.model})` : ""}
            </p>
          </div>
        )}

        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg) => {
            // Skip the placeholder assistant message if we're actively streaming it
            if (
              msg.role === "assistant" &&
              msg.id === activeMessageId &&
              streaming
            ) {
              return null;
            }

            return (
              <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "rounded-lg bg-muted/50 px-3 py-2.5" : ""}`}>
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  msg.role === "user"
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {msg.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  {msg.role === "user" ? (
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  ) : (
                    <div className="text-sm">
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      </div>
                      <ToolCallList toolEvents={msg.toolEvents} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Streaming response */}
          {streaming && (
            <div className="flex gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Bot className="h-3.5 w-3.5" />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <StreamingOutput events={streamEvents} streaming={true} />
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t bg-card px-4 py-3">
        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={streaming ? "Waiting for response..." : "Send a message..."}
            disabled={streaming}
            className="min-h-10 max-h-40 resize-none"
            rows={1}
          />
          {streaming ? (
            <Button
              onClick={handleStop}
              variant="destructive"
              size="icon"
              className="shrink-0 h-10 w-10"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={!input.trim() || sendMutation.isPending}
              size="icon"
              className="shrink-0 h-10 w-10"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export default function CaptainPage() {
  const queryClient = useQueryClient();
  const { orgId } = useScope();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileListOpen, setMobileListOpen] = useState(false);

  // Fetch conversations (org-scoped)
  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["captain-conversations", orgId],
    queryFn: () => apiFetch<Conversation[]>(scoped("/api/captain/conversations", { orgId })).catch(() => []),
    enabled: !!orgId,
  });

  // Auto-select first conversation — derive from data rather than setState in effect
  const effectiveConversationId =
    activeConversationId && conversations.some((c) => c.id === activeConversationId)
      ? activeConversationId
      : conversations.length > 0
        ? conversations[0].id
        : null;

  // Create new conversation (org-scoped)
  async function handleNew() {
    try {
      const data = await apiFetch<{ id: string }>(
        scoped("/api/captain/conversations", { orgId }),
        { method: "POST", body: { title: "New conversation" } }
      );
      queryClient.invalidateQueries({ queryKey: ["captain-conversations"] });
      setActiveConversationId(data.id);
    } catch {
      // ignore
    }
  }

  // Delete conversation
  async function handleDelete(id: string) {
    await apiFetch(`/api/captain/conversations/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: ["captain-conversations"] });
    if (activeConversationId === id) {
      setActiveConversationId(null);
    }
  }

  // Update conversation title
  async function handleTitleUpdate(id: string, title: string) {
    await apiFetch(`/api/captain/conversations/${id}`, {
      method: "PUT",
      body: { title },
    });
    queryClient.invalidateQueries({ queryKey: ["captain-conversations"] });
  }

  return (
    <div className="-mx-4 -mb-6 md:-mx-8 md:-mb-8 md:-mt-8 flex h-[calc(100dvh-4.5rem-env(safe-area-inset-top)-3.5rem)] md:h-[calc(100dvh)] overflow-hidden">
      {/* Conversation sidebar — desktop */}
      {sidebarOpen && (
        <div className="hidden md:flex w-64 shrink-0 border-r flex-col bg-card">
          <ConversationList
            conversations={conversations}
            activeId={effectiveConversationId}
            onSelect={setActiveConversationId}
            onNew={handleNew}
            onDelete={handleDelete}
          />
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <div className="shrink-0 flex items-center gap-2 border-b px-3 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex h-8 w-8"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </Button>
          {/* Mobile: conversation list + new chat */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-8 w-8"
            onClick={() => setMobileListOpen(true)}
          >
            <List className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium truncate flex-1">
            {conversations.find((c) => c.id === effectiveConversationId)?.title || "Captain"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-8 w-8"
            onClick={handleNew}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Link href="/settings" className="text-muted-foreground hover:text-foreground">
            <Settings className="h-4 w-4" />
          </Link>
        </div>

        {/* Chat content */}
        {effectiveConversationId ? (
          <ChatView
            key={effectiveConversationId}
            conversationId={effectiveConversationId}
            onTitleUpdate={handleTitleUpdate}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
            <MessageSquare className="h-12 w-12 text-muted-foreground/20 mb-4" />
            <h2 className="text-lg font-medium mb-1">Captain</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Chat with your CLI tool directly from the dashboard.
            </p>
            <Button onClick={handleNew} className="gap-2">
              <Plus className="h-4 w-4" /> New Chat
            </Button>
            <p className="text-xs text-muted-foreground mt-6">
              Configure your CLI tool, model, and working directory in{" "}
              <Link href="/settings" className="underline">Settings</Link>.
            </p>
          </div>
        )}
      </div>

      {/* Mobile conversation list sheet */}
      <Sheet open={mobileListOpen} onOpenChange={setMobileListOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <ConversationList
            conversations={conversations}
            activeId={effectiveConversationId}
            onSelect={(id) => {
              setActiveConversationId(id);
              setMobileListOpen(false);
            }}
            onNew={() => {
              handleNew();
              setMobileListOpen(false);
            }}
            onDelete={handleDelete}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
