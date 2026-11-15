import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  MessageCircle,
  Plus,
  Send,
  X,
} from 'lucide-react';
import { useRealtime } from '../hooks/useRealtime';
import { apiRequest } from '../lib/api';
import type {
  Profile,
  SupportConversation,
  SupportMessage,
  SupportPresence,
} from '../shared/types';
import { buildWhatsAppUrl } from './WhatsAppWidget';

const VISITOR_TOKEN_KEY = 'saqo_chat_visitor_token';

function getOrCreateVisitorToken(): string {
  try {
    const existing = localStorage.getItem(VISITOR_TOKEN_KEY);
    if (existing && existing.trim()) return existing;
    const created =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? `vis-${crypto.randomUUID()}`
        : `vis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(VISITOR_TOKEN_KEY, created);
    return created;
  } catch {
    return `vis-${Date.now()}`;
  }
}

interface SupportChatWidgetProps {
  currentUser: Profile | null;
  whatsappNumber: string;
  openSignal?: { nonce: number; trackingCode?: string } | null;
}

const QUICK_TOPICS = [
  'Track my parcel',
  'Request a pickup',
  'Pricing & state coverage',
  'OTP or delivery help',
];

export const SupportChatWidget: React.FC<SupportChatWidgetProps> = ({
  currentUser,
  whatsappNumber,
  openSignal,
}) => {
  const [visitorToken] = useState<string>(() => getOrCreateVisitorToken());
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'new' | 'thread'>('new');
  const [presence, setPresence] = useState<SupportPresence>({
    adminOnline: false,
    onlineAdminCount: 0,
  });
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminTyping, setAdminTyping] = useState(false);

  // Pre-chat / new chat form state
  const [visitorName, setVisitorName] = useState(currentUser?.fullName || '');
  const [visitorEmail, setVisitorEmail] = useState(currentUser?.email || '');
  const [visitorPhone, setVisitorPhone] = useState(currentUser?.phone || '');
  const [trackingCode, setTrackingCode] = useState('');
  const [firstMessage, setFirstMessage] = useState('');

  // Reply composer
  const [replyBody, setReplyBody] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const lastTypingEmitRef = useRef<number>(0);
  const presenceEventCount = useRef(0);

  useEffect(() => {
    if (currentUser) {
      setVisitorName((prev) => prev || currentUser.fullName);
      setVisitorEmail((prev) => prev || currentUser.email);
      setVisitorPhone((prev) => prev || currentUser.phone);
    }
  }, [currentUser]);

  const loadConversations = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await apiRequest<{
        conversations: SupportConversation[];
      }>(`/api/support/conversations?visitorToken=${encodeURIComponent(visitorToken)}`);
      setConversations(res.conversations);
      return res.conversations;
    } catch {
      return [];
    } finally {
      setLoadingList(false);
    }
  }, [visitorToken]);

  const loadMessages = useCallback(
    async (convId: string) => {
      setLoadingMsgs(true);
      setError(null);
      try {
        const res = await apiRequest<{
          conversation: SupportConversation;
          messages: SupportMessage[];
        }>(
          `/api/support/conversations/${encodeURIComponent(convId)}/messages?visitorToken=${encodeURIComponent(
            visitorToken
          )}`
        );
        setMessages(res.messages);
        setConversations((prev) =>
          prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
        );
      } catch (err: any) {
        setError(err.message || 'Could not load conversation history.');
      } finally {
        setLoadingMsgs(false);
      }
    },
    [visitorToken]
  );

  // Initial load of presence + saved conversations so unread badges & chat history persist immediately
  useEffect(() => {
    let active = true;
    const init = async () => {
      const list = await loadConversations();
      if (!active) return;
      if (list.length > 0) {
        const latest = list[0];
        setActiveConvId(latest.id);
        setView('thread');
      } else {
        setView('new');
      }
    };
    init();
    return () => {
      active = false;
    };
  }, [loadConversations, currentUser?.id]);

  // Open chat drawer externally (e.g. from parcel tracking card)
  useEffect(() => {
    if (!openSignal) return;
    setOpen(true);
    if (openSignal.trackingCode) {
      setTrackingCode(openSignal.trackingCode);
      const matching = conversations.find(
        (c) =>
          c.trackingCode?.toUpperCase() === openSignal.trackingCode?.toUpperCase() &&
          c.status !== 'closed'
      );
      if (matching) {
        setActiveConvId(matching.id);
        setView('thread');
      } else {
        setView('new');
      }
    }
  }, [openSignal?.nonce]);

  // Load messages whenever active thread opens
  useEffect(() => {
    if (open && view === 'thread' && activeConvId) {
      loadMessages(activeConvId);
    }
  }, [open, view, activeConvId, loadMessages]);

  // Auto-scroll chat thread to bottom
  useEffect(() => {
    if (open && view === 'thread') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, adminTyping, open, view]);

  const { sendEvent, connected } = useRealtime((evt) => {
    if (evt.type === 'support:presence') {
      presenceEventCount.current += 1;
      const p = evt.payload as SupportPresence;
      setPresence(p);
      setPresenceLoaded(true);
    } else if (evt.type === 'support:conversation') {
      const conv = evt.payload as SupportConversation;
      const belongsToMe =
        conv.visitorToken === visitorToken ||
        (currentUser?.id && conv.userId === currentUser.id);
      if (!belongsToMe) return;
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === conv.id);
        const next = exists
          ? prev.map((c) => (c.id === conv.id ? conv : c))
          : [conv, ...prev];
        return next.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      });
    } else if (evt.type === 'support:message') {
      const msg = evt.payload as SupportMessage;
      if (msg.conversationId === activeConvId) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        if (msg.senderRole === 'admin') {
          setAdminTyping(false);
          if (open && view === 'thread') {
            apiRequest(`/api/support/conversations/${encodeURIComponent(msg.conversationId)}/read`, {
              method: 'POST',
              body: JSON.stringify({ visitorToken }),
            }).catch(() => {});
          }
        }
      }
    } else if (evt.type === 'support:typing') {
      const t = evt.payload as {
        conversationId: string;
        senderRole: string;
        isTyping: boolean;
      };
      if (t.conversationId === activeConvId && t.senderRole === 'admin') {
        setAdminTyping(t.isTyping);
        if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
        if (t.isTyping) {
          typingTimerRef.current = window.setTimeout(() => setAdminTyping(false), 3500);
        }
      }
    }
  });

  useEffect(() => {
    if (!connected) return;
    sendEvent({ type: 'support:subscribe', visitorToken });
    return () => sendEvent({ type: 'support:subscribe', visitorToken: '' });
  }, [connected, sendEvent, visitorToken]);

  useEffect(() => {
    if (connected) return;
    let active = true;
    let timer: number;
    let request: AbortController;
    const refreshPresence = async () => {
      const eventCount = presenceEventCount.current;
      request = new AbortController();
      const timeout = window.setTimeout(() => request.abort(), 5000);
      try {
        const result = await apiRequest<SupportPresence>('/api/support/presence', {
          cache: 'no-store',
          signal: request.signal,
        });
        if (active && eventCount === presenceEventCount.current && typeof result.adminOnline === 'boolean') {
          setPresence(result);
          setPresenceLoaded(true);
        }
      } catch {
        // Preserve the last known presence until the desk can be reached again.
      } finally {
        window.clearTimeout(timeout);
        if (active) timer = window.setTimeout(refreshPresence, 10000);
      }
    };
    refreshPresence();
    return () => {
      active = false;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, [connected]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConvId) || null,
    [conversations, activeConvId]
  );

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadByVisitor || 0), 0),
    [conversations]
  );

  const handleStartConversation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!visitorName.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (!firstMessage.trim()) {
      setError('Please enter a message to send.');
      return;
    }
    setSending(true);
    try {
      const res = await apiRequest<{
        conversation: SupportConversation;
        messages: SupportMessage[];
      }>('/api/support/conversations', {
        method: 'POST',
        body: JSON.stringify({
          visitorToken,
          visitorName: visitorName.trim(),
          visitorEmail: visitorEmail.trim() || null,
          visitorPhone: visitorPhone.trim() || null,
          trackingCode: trackingCode.trim() || null,
          message: firstMessage.trim(),
        }),
      });
      setConversations((prev) => [
        res.conversation,
        ...prev.filter((c) => c.id !== res.conversation.id),
      ]);
      setActiveConvId(res.conversation.id);
      setMessages(res.messages);
      setFirstMessage('');
      setView('thread');
    } catch (err: any) {
      setError(err.message || 'Could not start support chat.');
    } finally {
      setSending(false);
    }
  };

  const handleSendReply = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!activeConvId || !replyBody.trim() || sending) return;
    const text = replyBody.trim();
    setSending(true);
    setError(null);
    try {
      const res = await apiRequest<{
        conversation: SupportConversation;
        message: SupportMessage;
      }>(`/api/support/conversations/${encodeURIComponent(activeConvId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          visitorToken,
          body: text,
        }),
      });
      setReplyBody('');
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
      setConversations((prev) =>
        prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
      );
      sendEvent({
        type: 'support:typing',
        conversationId: activeConvId,
        senderRole: 'visitor',
        senderName: visitorName || 'Visitor',
        isTyping: false,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  const handleToggleStatus = async (nextStatus: 'resolved' | 'open') => {
    if (!activeConvId) return;
    try {
      const res = await apiRequest<{
        conversation: SupportConversation;
        systemMessage: SupportMessage;
      }>(`/api/support/conversations/${encodeURIComponent(activeConvId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ visitorToken, status: nextStatus }),
      });
      if (res?.conversation) {
        setConversations((prev) =>
          prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
        );
      }
      if (res?.systemMessage) {
        setMessages((prev) =>
          prev.some((m) => m.id === res.systemMessage.id)
            ? prev
            : [...prev, res.systemMessage]
        );
      }
    } catch (err: any) {
      setError(err.message || 'Could not update chat status.');
    }
  };

  const emitTyping = (value: string) => {
    setReplyBody(value);
    if (!activeConvId) return;
    const now = Date.now();
    if (now - lastTypingEmitRef.current > 1200) {
      lastTypingEmitRef.current = now;
      sendEvent({
        type: 'support:typing',
        conversationId: activeConvId,
        senderRole: 'visitor',
        senderName: visitorName || 'Visitor',
        isTyping: Boolean(value.trim()),
      });
    }
  };

  const whatsappHref = buildWhatsAppUrl(
    whatsappNumber,
    trackingCode
      ? `Hello SAQO Support, I need assistance with parcel ${trackingCode}.`
      : 'Hello SAQO Support, I need assistance with a parcel delivery.'
  );

  return (
    <div className="fixed bottom-20 md:bottom-5 right-4 md:right-5 z-40 flex flex-col items-end gap-3">
      {open && (
        <div
          role="dialog"
          aria-label="SAQO Live Support Chat"
          className="w-[calc(100vw-2rem)] sm:w-96 max-h-[75vh] bg-white text-black border border-black rounded-xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header with live Admin online presence */}
          <div className="bg-black text-white px-4 py-3.5 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {(view === 'thread' || (view === 'new' && conversations.length > 0)) && (
                <button
                  type="button"
                  onClick={() => {
                    loadConversations();
                    setView('list');
                  }}
                  aria-label="View saved conversations"
                  className="p-1.5 rounded-lg hover:bg-white/15 text-neutral-300 hover:text-white cursor-pointer shrink-0"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <div className="min-w-0">
                <p className="font-display font-bold text-sm leading-tight truncate">
                  SAQO Live Support
                </p>
                <p className="text-[11px] text-neutral-300 mt-0.5 flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      presence.adminOnline ? 'bg-white' : 'border border-neutral-400 bg-transparent'
                    }`}
                  />
                  <span className="truncate">
                    {!presenceLoaded
                      ? 'Connecting to support...'
                      : presence.adminOnline
                      ? 'Admin Online · Live replies'
                      : 'Agents Offline · Reply queued'}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Open WhatsApp fallback"
                aria-label="Open WhatsApp fallback"
                className="p-1.5 rounded-md hover:bg-white/15 text-neutral-300 hover:text-white transition-colors"
              >
                <ArrowUpRight className="w-4 h-4" />
              </a>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close support chat"
                className="p-1.5 rounded-md hover:bg-white/15 text-neutral-300 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Offline Notice Banner whenever no Admin is currently online */}
          {presenceLoaded && !presence.adminOnline && (
            <div
              role="status"
              className="px-4 py-2.5 bg-neutral-100 border-b border-neutral-200 text-xs text-neutral-700 leading-relaxed shrink-0 flex items-start gap-2"
            >
              <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-black" />
              <span>
                Our agents are currently offline. Leave your message below — all chats stay saved and you will receive a reply here when an agent is online.
              </span>
            </div>
          )}

          {/* VIEW 1: Saved Conversations List */}
          {view === 'list' && (
            <div className="flex-1 overflow-y-auto divide-y divide-neutral-200 bg-white">
              <div className="p-3.5 flex items-center justify-between bg-neutral-50 border-b border-neutral-200">
                <p className="text-xs font-semibold text-neutral-600">
                  Your Chats ({conversations.length})
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setView('new');
                  }}
                  className="inline-flex items-center gap-1 bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-neutral-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Chat</span>
                </button>
              </div>

              {loadingList ? (
                <div className="p-6 text-center text-xs text-neutral-500">
                  Loading conversations...
                </div>
              ) : conversations.length === 0 ? (
                <div className="p-8 text-center space-y-3">
                  <p className="text-sm font-semibold">No saved chats yet</p>
                  <p className="text-xs text-neutral-500">
                    Start a conversation with SAQO Operations anytime.
                  </p>
                  <button
                    type="button"
                    onClick={() => setView('new')}
                    className="bg-black text-white px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer"
                  >
                    Start Support Chat
                  </button>
                </div>
              ) : (
                conversations.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => {
                      setActiveConvId(conv.id);
                      setView('thread');
                    }}
                    className="w-full text-left p-3.5 hover:bg-neutral-50 transition-colors cursor-pointer space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-xs text-black truncate flex items-center gap-1.5">
                        {conv.unreadByVisitor > 0 && (
                          <span className="w-2 h-2 rounded-full bg-black shrink-0" />
                        )}
                        <span>{conv.trackingCode ? `Parcel ${conv.trackingCode}` : conv.visitorName}</span>
                      </span>
                      <span className="text-[10px] font-semibold uppercase border border-neutral-300 px-1.5 py-0.5 rounded text-neutral-700 shrink-0">
                        {conv.status}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-600 truncate">
                      {conv.lastMessagePreview || 'Conversation started'}
                    </p>
                    <p className="font-mono text-[10px] text-neutral-400">
                      {new Date(conv.lastMessageAt).toLocaleString()}
                    </p>
                  </button>
                ))
              )}
            </div>
          )}

          {/* VIEW 2: Start New Support Conversation */}
          {view === 'new' && (
            <form
              onSubmit={handleStartConversation}
              className="flex-1 overflow-y-auto p-4 space-y-3 bg-white"
            >
              <div className="flex flex-wrap gap-1.5">
                {QUICK_TOPICS.map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    onClick={() =>
                      setFirstMessage((prev) => (prev ? prev : `${topic}: `))
                    }
                    className="border border-neutral-300 hover:border-black px-2.5 py-1 rounded-md text-[11px] font-medium text-neutral-700 cursor-pointer"
                  >
                    {topic}
                  </button>
                ))}
              </div>

              {!currentUser && (
                <>
                  <div>
                    <label htmlFor="chat-visitor-name" className="block text-[11px] font-semibold mb-1">
                      Your Name
                    </label>
                    <input
                      id="chat-visitor-name"
                      type="text"
                      required
                      value={visitorName}
                      onChange={(e) => setVisitorName(e.target.value)}
                      placeholder="e.g. Ibrahim Musa"
                      className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor="chat-visitor-phone" className="block text-[11px] font-semibold mb-1">
                        Phone
                      </label>
                      <input
                        id="chat-visitor-phone"
                        type="tel"
                        value={visitorPhone}
                        onChange={(e) => setVisitorPhone(e.target.value)}
                        placeholder="+234 803..."
                        className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-black"
                      />
                    </div>
                    <div>
                      <label htmlFor="chat-visitor-email" className="block text-[11px] font-semibold mb-1">
                        Email (optional)
                      </label>
                      <input
                        id="chat-visitor-email"
                        type="email"
                        value={visitorEmail}
                        onChange={(e) => setVisitorEmail(e.target.value)}
                        placeholder="you@..."
                        className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-black"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label htmlFor="chat-tracking-code" className="block text-[11px] font-semibold mb-1">
                  Tracking Code (optional)
                </label>
                <input
                  id="chat-tracking-code"
                  type="text"
                  value={trackingCode}
                  onChange={(e) => setTrackingCode(e.target.value.toUpperCase())}
                  placeholder="e.g. SQ-2026-1234"
                  className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div>
                <label htmlFor="chat-first-message" className="block text-[11px] font-semibold mb-1">
                  How can we help?
                </label>
                <textarea
                  id="chat-first-message"
                  required
                  rows={3}
                  value={firstMessage}
                  onChange={(e) => setFirstMessage(e.target.value)}
                  placeholder="Write your question about a pickup, delivery, or rider..."
                  className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-black resize-none"
                />
              </div>

              {error && (
                <p role="alert" className="text-xs font-medium text-black bg-neutral-100 border border-black rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={sending}
                className="w-full inline-flex items-center justify-center gap-2 bg-black text-white py-2.5 rounded-lg text-xs font-bold hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{sending ? 'Starting Chat...' : 'Send Message'}</span>
              </button>
            </form>
          )}

          {/* VIEW 3: Active Persistent Conversation Thread */}
          {view === 'thread' && activeConversation && (
            <>
              <div className="px-4 py-2 border-b border-neutral-200 bg-neutral-50 flex items-center justify-between gap-2 text-[11px] shrink-0">
                <span className="font-mono text-neutral-600 truncate">
                  {activeConversation.trackingCode
                    ? `Parcel ${activeConversation.trackingCode}`
                    : `Chat · ${activeConversation.visitorName}`}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="capitalize font-semibold border border-neutral-300 px-1.5 py-0.5 rounded bg-white">
                    {activeConversation.status}
                  </span>
                  {activeConversation.status !== 'resolved' ? (
                    <button
                      type="button"
                      onClick={() => handleToggleStatus('resolved')}
                      className="text-neutral-600 hover:text-black underline cursor-pointer"
                    >
                      Resolve
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleToggleStatus('open')}
                      className="text-black font-semibold underline cursor-pointer"
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-white min-h-[220px]">
                {loadingMsgs && messages.length === 0 ? (
                  <p className="text-xs text-neutral-500 text-center py-8">
                    Loading conversation...
                  </p>
                ) : (
                  messages.map((m) => {
                    if (m.senderRole === 'system') {
                      return (
                        <div key={m.id} className="text-center py-1">
                          <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500 bg-neutral-100 px-2.5 py-1 rounded-md">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{m.body}</span>
                          </span>
                        </div>
                      );
                    }
                    const isMine = m.senderRole !== 'admin';
                    return (
                      <div
                        key={m.id}
                        className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                      >
                        <span className="text-[10px] text-neutral-500 mb-0.5 px-1">
                          {isMine ? 'You' : m.senderName} ·{' '}
                          {new Date(m.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <div
                          className={`max-w-[85%] rounded-xl px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                            isMine
                              ? 'bg-black text-white rounded-br-sm'
                              : 'bg-neutral-100 text-black border border-neutral-200 rounded-bl-sm'
                          }`}
                        >
                          {m.body}
                        </div>
                      </div>
                    );
                  })
                )}

                {adminTyping && (
                  <div className="flex items-start">
                    <div className="bg-neutral-100 border border-neutral-200 text-neutral-600 rounded-xl px-3 py-1.5 text-[11px] italic">
                      SAQO Support is typing...
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {error && (
                <p role="alert" className="px-4 py-1.5 text-[11px] font-medium bg-neutral-100 border-t border-neutral-200">
                  {error}
                </p>
              )}

              <form
                onSubmit={handleSendReply}
                className="p-3 border-t border-neutral-200 bg-neutral-50 flex items-end gap-2 shrink-0"
              >
                <label htmlFor="chat-reply-input" className="sr-only">
                  Reply message
                </label>
                <textarea
                  id="chat-reply-input"
                  rows={1}
                  value={replyBody}
                  onChange={(e) => emitTyping(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendReply();
                    }
                  }}
                  placeholder={
                    presence.adminOnline
                      ? 'Write a message...'
                      : 'Leave a message (reply when online)...'
                  }
                  className="flex-1 min-w-0 bg-white border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-black resize-none"
                />
                <button
                  type="submit"
                  disabled={sending || !replyBody.trim()}
                  aria-label="Send chat message"
                  className="bg-black text-white p-2.5 rounded-lg hover:bg-neutral-800 disabled:opacity-40 transition-colors shrink-0 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </>
          )}
        </div>
      )}

      {/* Floating Support Chat Launcher with Live Admin Presence Indicator & Unread Badge */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="SAQO Support Chat"
        aria-expanded={open}
        className="relative inline-flex items-center justify-center gap-2 bg-black text-white border border-white/25 px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-full shadow-lg hover:bg-neutral-800 transition-transform active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
      >
        <MessageCircle className="w-4 h-4 shrink-0" />
        <span className="text-xs sm:text-sm font-semibold">Support Chat</span>
        {presenceLoaded && (
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
              presence.adminOnline
                ? 'bg-white text-black'
                : 'bg-neutral-800 text-neutral-300 border border-white/20'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                presence.adminOnline ? 'bg-black' : 'bg-neutral-400'
              }`}
            />
            <span>{presence.adminOnline ? 'Online' : 'Offline'}</span>
          </span>
        )}
        {totalUnread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-white text-black border border-black text-[10px] font-bold flex items-center justify-center tabular-nums">
            {totalUnread}
          </span>
        )}
      </button>
    </div>
  );
};
