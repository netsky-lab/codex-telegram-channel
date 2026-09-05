#!/usr/bin/env node

import readline from "node:readline";
import { openAsBlob } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configWarnings = [];
const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedChatIds = csvSet(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
const allowedThreadIds = threadIdSet(process.env.TELEGRAM_ALLOWED_THREAD_IDS);
const allowedRoutes = routeSet(process.env.TELEGRAM_ALLOWED_ROUTES);
const pollTimeoutSec = parseIntegerEnv("TELEGRAM_POLL_TIMEOUT_SEC", 25, { min: 1, max: 50 });
const allowAllChats = process.env.TELEGRAM_ALLOW_ALL_CHATS === "1";
const telegramDebug = process.env.TELEGRAM_DEBUG === "1";
const seenReaction = String(process.env.TELEGRAM_SEEN_REACTION ?? "👀").trim();
const downloadDir =
  process.env.TELEGRAM_DOWNLOAD_DIR ??
  path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "telegram-channel-files",
  );
const maxDownloadBytes = parseIntegerEnv("TELEGRAM_MAX_DOWNLOAD_BYTES", 20 * 1024 * 1024, {
  min: 1,
  max: 2 * 1024 * 1024 * 1024,
});
const offsetFile =
  process.env.TELEGRAM_OFFSET_FILE ??
  path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "telegram-channel-offset.json",
  );
const pollLockFile = process.env.TELEGRAM_POLL_LOCK_FILE ?? `${offsetFile}.lock`;
const routeCacheFile = process.env.TELEGRAM_ROUTE_CACHE_FILE ?? `${offsetFile}.routes.json`;
const maxTelegramMessageLength = 4096;
const initialParentPid = process.ppid;
const lockPayload = `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`;

let nextId = 1;
let initialized = false;
let channelConsumerAvailable = false;
let polling = false;
let shuttingDown = false;
let pollLockStatus = "not_acquired";
let pollLockHandle = null;
let updateOffset = 0;
let lastChatId = null;
let lastMessageThreadId = undefined;
let seenUpdates = 0;
let acceptedUpdates = 0;
let rejectedUpdates = 0;
let ignoredUpdates = 0;
let lastIgnoredReason = "none";
let lastUpdateSummary = "none";
let botIdentity = null;
const recentMessages = new Map();

if (process.argv.includes("--self-test")) {
  runSelfTest()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exit(1);
    });
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    logError(`invalid JSON-RPC payload: ${error.message}`);
    return;
  }

  try {
    if (message.id !== undefined) {
      if (message.method === "initialize") {
        channelConsumerAvailable = supportsChannelNotifications(message.params);
      }
      await handleRequest(message);
    } else if (message.method === "notifications/initialized" || message.method === "initialized") {
      initialized = true;
      startPolling();
    }
  } catch (error) {
    if (message.id !== undefined) {
      sendError(message.id, -32603, error.message);
    } else {
      logError(error.message);
    }
  }
});

rl.on("close", () => {
  void shutdown();
});

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("exit", () => {
  releasePollingLockSync();
});

const parentWatchdog = setInterval(() => {
  if (shuttingDown || initialParentPid <= 1) {
    return;
  }
  if (process.ppid === 1) {
    logError("Telegram channel parent process exited; shutting down bridge");
    void shutdown();
    return;
  }
  try {
    process.kill(initialParentPid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      logError("Telegram channel parent process is gone; shutting down bridge");
      void shutdown();
    }
  }
}, 5000);
parentWatchdog.unref?.();

const lockWatchdog = setInterval(() => {
  if (!pollLockHandle || pollLockStatus !== "acquired" || shuttingDown) {
    return;
  }
  void verifyPollingLock();
}, 5000);
lockWatchdog.unref?.();

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      sendResult(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "telegram-channel",
          version: "0.5.2",
          title: "Telegram Channel",
        },
        instructions:
          "Telegram messages arrive as JSON channel user input. Use telegram_typing before longer work and telegram_reply with channel_message_id to answer the originating Telegram chat. In groups, inspect metadata.addressing and metadata.reply_to: prefer replying when probably_addressed_to_bot is true or the conversation context clearly asks this bot, and avoid replying to messages addressed to a different bot.",
      });
      break;
    case "ping":
      sendResult(message.id, {});
      break;
    case "tools/list":
      sendResult(message.id, {
        tools: [
          {
            name: "telegram_reply",
            title: "Reply in Telegram",
            description:
              "Send a message back to the Telegram chat that produced the latest channel message, or to a specific chat_id.",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description: "Message text to send.",
                },
                chat_id: {
                  type: "string",
                  description:
                    "Optional Telegram chat id. Defaults to the most recent allowed inbound chat.",
                },
                reply_to_message_id: {
                  type: "integer",
                  description: "Optional Telegram message id to reply to.",
                },
                message_thread_id: {
                  type: "integer",
                  description:
                    "Optional Telegram forum topic id. Defaults from channel_message_id when provided.",
                },
                channel_message_id: {
                  type: "string",
                  description:
                    "Optional inbound channel message id. Uses that message's chat, topic, and reply id.",
                },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
          {
            name: "telegram_typing",
            title: "Show Telegram chat action",
            description:
              "Show a Telegram chat action, such as typing, in the originating Telegram chat or a specific chat_id.",
            inputSchema: {
              type: "object",
              properties: {
                chat_id: {
                  type: "string",
                  description:
                    "Optional Telegram chat id. Defaults to the most recent allowed inbound chat.",
                },
                channel_message_id: {
                  type: "string",
                  description:
                    "Optional inbound channel message id. Uses that message's chat and topic.",
                },
                message_thread_id: {
                  type: "integer",
                  description:
                    "Optional Telegram forum topic id. Defaults from channel_message_id when provided.",
                },
                action: {
                  type: "string",
                  description:
                    "Telegram chat action. Defaults to typing.",
                  enum: [
                    "typing",
                    "upload_photo",
                    "record_video",
                    "upload_video",
                    "record_voice",
                    "upload_voice",
                    "upload_document",
                    "choose_sticker",
                    "find_location",
                    "record_video_note",
                    "upload_video_note",
                  ],
                },
                seconds: {
                  type: "integer",
                  description:
                    "How long to keep refreshing the action. Defaults to 4, maximum 30.",
                  minimum: 1,
                  maximum: 30,
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "telegram_react",
            title: "React to Telegram message",
            description:
              "Set an emoji reaction on an inbound Telegram message.",
            inputSchema: {
              type: "object",
              properties: {
                chat_id: {
                  type: "string",
                  description:
                    "Optional Telegram chat id. Defaults to the most recent allowed inbound chat.",
                },
                message_id: {
                  type: "integer",
                  description:
                    "Optional Telegram message id. Defaults from channel_message_id when provided.",
                },
                channel_message_id: {
                  type: "string",
                  description:
                    "Optional inbound channel message id. Uses that message's chat and message id.",
                },
                emoji: {
                  type: "string",
                  description: "Emoji reaction to set. Defaults to 👀.",
                },
                is_big: {
                  type: "boolean",
                  description: "Whether Telegram should render a big reaction animation.",
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "telegram_send_file",
            title: "Send file in Telegram",
            description:
              "Upload a local file to the originating Telegram chat or a specific chat_id.",
            inputSchema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Local file path to send.",
                },
                chat_id: {
                  type: "string",
                  description:
                    "Optional Telegram chat id. Defaults to the most recent allowed inbound chat.",
                },
                channel_message_id: {
                  type: "string",
                  description:
                    "Optional inbound channel message id. Uses that message's chat and topic.",
                },
                message_thread_id: {
                  type: "integer",
                  description:
                    "Optional Telegram forum topic id. Defaults from channel_message_id when provided.",
                },
                caption: {
                  type: "string",
                  description: "Optional Telegram caption.",
                },
                as_photo: {
                  type: "boolean",
                  description:
                    "Send as a Telegram photo instead of a document. Only use for image files.",
                },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          {
            name: "telegram_status",
            title: "Telegram channel status",
            description: "Report Telegram channel bridge polling and routing state.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      break;
    case "tools/call":
      await handleToolCall(message);
      break;
    default:
      sendError(message.id, -32601, `unsupported method: ${message.method}`);
      break;
  }
}

async function handleToolCall(message) {
  const { name, arguments: args = {} } = message.params ?? {};
  if (name === "telegram_status") {
    sendToolResult(message.id, statusText(), false);
    return;
  }
  if (!token) {
    sendToolResult(message.id, "TELEGRAM_BOT_TOKEN is not set.", true);
    return;
  }

  if (name === "telegram_typing") {
    await handleTypingTool(message.id, args);
    return;
  }
  if (name === "telegram_react") {
    await handleReactTool(message.id, args);
    return;
  }
  if (name === "telegram_send_file") {
    await handleSendFileTool(message.id, args);
    return;
  }
  if (name !== "telegram_reply") {
    sendError(message.id, -32602, `unknown tool: ${name}`);
    return;
  }

  const text = String(args.text ?? "").trim();
  const route = await resolveTelegramRoute(args);
  const chatId = route.chatId;
  const replyToMessageId = args.reply_to_message_id ?? route.replyToMessageId;
  const messageThreadId = route.messageThreadId;
  if (!text) {
    sendToolResult(message.id, "text is required.", true);
    return;
  }
  if (!chatId) {
    sendToolResult(message.id, "No Telegram chat is available yet.", true);
    return;
  }
  if (!chatAllowed(chatId, messageThreadId)) {
    sendToolResult(message.id, `Telegram route ${routeKey(chatId, messageThreadId)} is not allowed.`, true);
    return;
  }

  await tryTelegram(
    "sendChatAction",
    chatActionPayload(chatId, "typing", messageThreadId),
    "telegram_reply typing",
  );
  for (const chunk of splitTelegramMessage(text)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...threadPayload(messageThreadId),
      ...(Number.isInteger(replyToMessageId)
        ? { reply_to_message_id: replyToMessageId }
        : {}),
    });
  }
  sendToolResult(message.id, `sent to Telegram chat ${chatId}`, false);
}

async function handleTypingTool(id, args) {
  const route = await resolveTelegramRoute(args);
  const chatId = route.chatId;
  const messageThreadId = route.messageThreadId;
  const action = String(args.action ?? "typing").trim() || "typing";
  const seconds = clampInteger(args.seconds ?? 4, 1, 30);
  if (!chatId) {
    sendToolResult(id, "No Telegram chat is available yet.", true);
    return;
  }
  if (!chatAllowed(chatId, messageThreadId)) {
    sendToolResult(id, `Telegram route ${routeKey(chatId, messageThreadId)} is not allowed.`, true);
    return;
  }
  await sendChatActionFor(chatId, action, seconds, messageThreadId);
  sendToolResult(id, `sent ${action} to Telegram route ${routeKey(chatId, messageThreadId)}`, false);
}

async function handleReactTool(id, args) {
  const route = await resolveTelegramRoute(args);
  const chatId = route.chatId;
  const messageId = args.message_id ?? route.messageId ?? route.replyToMessageId;
  const emoji = String(args.emoji ?? "👀").trim() || "👀";
  if (!chatId) {
    sendToolResult(id, "No Telegram chat is available yet.", true);
    return;
  }
  const messageThreadId = route.messageThreadId;
  if (!chatAllowed(chatId, messageThreadId)) {
    sendToolResult(id, `Telegram route ${routeKey(chatId, messageThreadId)} is not allowed.`, true);
    return;
  }
  if (!Number.isInteger(messageId)) {
    sendToolResult(id, "message_id or channel_message_id is required.", true);
    return;
  }
  await setTelegramReaction(chatId, messageId, emoji, Boolean(args.is_big));
  sendToolResult(id, `reacted ${emoji} in Telegram chat ${chatId}`, false);
}

async function handleSendFileTool(id, args) {
  const route = await resolveTelegramRoute(args);
  const chatId = route.chatId;
  const messageThreadId = route.messageThreadId;
  const filePath = String(args.path ?? "").trim();
  const caption = String(args.caption ?? "").trim();
  if (!chatId) {
    sendToolResult(id, "No Telegram chat is available yet.", true);
    return;
  }
  if (!chatAllowed(chatId, messageThreadId)) {
    sendToolResult(id, `Telegram route ${routeKey(chatId, messageThreadId)} is not allowed.`, true);
    return;
  }
  if (!filePath) {
    sendToolResult(id, "path is required.", true);
    return;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    sendToolResult(id, `File does not exist: ${filePath}`, true);
    return;
  }

  const asPhoto = Boolean(args.as_photo);
  await tryTelegram(
    "sendChatAction",
    chatActionPayload(chatId, asPhoto ? "upload_photo" : "upload_document", messageThreadId),
    "telegram_send_file action",
  );
  await telegramMultipart(
    asPhoto ? "sendPhoto" : "sendDocument",
    {
      chat_id: chatId,
      ...threadPayload(messageThreadId),
      ...(caption ? { caption } : {}),
    },
    asPhoto ? "photo" : "document",
    filePath,
  );
  sendToolResult(id, `sent file to Telegram chat ${chatId}`, false);
}

function sendToolResult(id, text, isError) {
  sendResult(id, {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError,
  });
}

function startPolling() {
  const state = pollingStartState();
  return maybeStartPolling(state, () => {
    logConfigWarnings();
    void startPollingWithLock();
  });
}

function supportsChannelNotifications(initializeParams) {
  const capability =
    initializeParams?.capabilities?.experimental?.["codex/channel-notifications"];
  return capability?.schemaVersion === 1;
}

function pollingStartState() {
  return {
    polling,
    initialized,
    channelConsumerAvailable,
    hasToken: Boolean(token),
    hasAllowedRoutes:
      allowedChatIds.size > 0 || allowedRoutes.size > 0 || allowAllChats,
  };
}

function pollingWaitReason(state = pollingStartState()) {
  if (state.polling) {
    return null;
  }
  if (!state.initialized) {
    return "awaiting_initialized";
  }
  if (!state.channelConsumerAvailable) {
    return "no_channel_consumer";
  }
  if (!state.hasToken) {
    return "missing_bot_token";
  }
  if (!state.hasAllowedRoutes) {
    return "missing_allowed_routes";
  }
  return null;
}

function maybeStartPolling(state, startWithLock) {
  if (state.polling || pollingWaitReason(state) !== null) {
    return false;
  }
  startWithLock();
  return true;
}

async function startPollingWithLock() {
  if (polling) {
    return;
  }
  if (!(await acquirePollingLock())) {
    return;
  }
  polling = true;
  void pollLoop();
}

async function pollLoop() {
  if (!token) {
    logError("TELEGRAM_BOT_TOKEN is not set; Telegram channel polling is disabled.");
    return;
  }
  if (allowedChatIds.size === 0 && allowedRoutes.size === 0 && !allowAllChats) {
    logError(
      "TELEGRAM_ALLOWED_CHAT_IDS or TELEGRAM_ALLOWED_ROUTES is required unless TELEGRAM_ALLOW_ALL_CHATS=1; Telegram channel polling is disabled.",
    );
    return;
  }

  await ensureBotIdentity();
  updateOffset = await readOffset();

  while (!shuttingDown) {
    try {
      const result = await telegram("getUpdates", {
        offset: updateOffset,
        timeout: pollTimeoutSec,
        allowed_updates: ["message", "edited_message", "channel_post"],
      });
      for (const update of result) {
        seenUpdates += 1;
        lastUpdateSummary = summarizeUpdate(update);
        updateOffset = Math.max(updateOffset, update.update_id + 1);
        await handleTelegramUpdate(update);
        await writeOffset(updateOffset);
      }
    } catch (error) {
      if (shuttingDown) {
        break;
      }
      logError(`Telegram polling failed: ${describeError(error)}`);
      await sleep(error.retryAfterMs ?? 3000);
    }
  }
}

async function acquirePollingLock() {
  try {
    await fs.mkdir(path.dirname(pollLockFile), { recursive: true });
    pollLockHandle = await fs.open(pollLockFile, "wx", 0o600);
    await pollLockHandle.writeFile(lockPayload);
    pollLockStatus = "acquired";
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      if (!(await lockHeldByLiveProcess())) {
        await fs.unlink(pollLockFile).catch(() => {});
        return acquirePollingLock();
      }
      pollLockStatus = "held_by_other_process";
      logInfo(`Telegram polling disabled in this MCP process because lock is held: ${pollLockFile}`);
      return false;
    }
    pollLockStatus = `failed:${error?.code ?? "unknown"}`;
    logError(`Telegram polling lock failed: ${describeError(error)}`);
    return false;
  }
}

async function verifyPollingLock() {
  const raw = await fs.readFile(pollLockFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === lockPayload) {
    return;
  }
  if (raw === null) {
    try {
      await fs.writeFile(pollLockFile, lockPayload, { mode: 0o600, flag: "wx" });
      logInfo(`Telegram polling lock restored: ${pollLockFile}`);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        logError(`Telegram polling lock restore failed: ${describeError(error)}`);
      }
    }
  }

  pollLockStatus = "lost";
  logError(`Telegram polling lock lost to another process; shutting down bridge: ${pollLockFile}`);
  void shutdown();
}

async function lockHeldByLiveProcess() {
  const raw = await fs.readFile(pollLockFile, "utf8").catch(() => "");
  const lock = safeJsonParse(raw);
  const pid = lock?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    if (await isOrphanedTelegramBridge(pid)) {
      return false;
    }
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function isOrphanedTelegramBridge(pid) {
  if (pid === process.pid || process.platform !== "linux") {
    return false;
  }
  try {
    const [stat, cmdline] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    const ppid = parseProcStatParentPid(stat);
    return ppid === 1 && cmdline.includes("telegram-channel.mjs");
  } catch {
    return false;
  }
}

function parseProcStatParentPid(stat) {
  const end = stat.lastIndexOf(")");
  if (end < 0) {
    return undefined;
  }
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) ? ppid : undefined;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  polling = false;
  await releasePollingLock();
  process.exit(0);
}

async function releasePollingLock() {
  if (!pollLockHandle) {
    return;
  }
  const handle = pollLockHandle;
  pollLockHandle = null;
  try {
    await handle.close();
    await fs.unlink(pollLockFile);
  } catch {
    // Best-effort cleanup; stale locks can be removed by deleting the lock file.
  }
}

function releasePollingLockSync() {
  if (!pollLockHandle) {
    return;
  }
  pollLockHandle = null;
  try {
    fsSync.unlinkSync(pollLockFile);
  } catch {
    // Best-effort cleanup during process exit.
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message?.chat?.id) {
    ignoreUpdate("missing message.chat.id");
    return;
  }

  const chatId = String(message.chat.id);
  const messageThreadId = message.message_thread_id;
  if (!chatAllowed(chatId, messageThreadId)) {
    rejectedUpdates += 1;
    return;
  }

  const attachments = await collectTelegramAttachments(message, chatId);
  const text = message.text ?? message.caption ?? defaultAttachmentText(attachments);
  if (!text && attachments.length === 0) {
    ignoreUpdate(`missing text/caption/attachment in ${Object.keys(message).join(",")}`);
    return;
  }

  lastChatId = chatId;
  lastMessageThreadId = messageThreadId;
  acceptedUpdates += 1;
  const channelMessageId = `telegram:${chatId}:${message.message_id}`;
  const replyTo = summarizeReplyToMessage(message.reply_to_message);
  const sender = summarizeTelegramUser(message.from);
  const addressing = computeAddressing(message, text, replyTo);
  await rememberMessage(channelMessageId, {
    chatId,
    messageId: message.message_id,
    replyToMessageId: message.message_id,
    messageThreadId,
  });
  if (seenReaction && seenReaction !== "0") {
    await tryTelegram(
      "setMessageReaction",
      reactionPayload(chatId, message.message_id, seenReaction, false),
      "auto seen reaction",
    );
  }
  sendChannelNotification("notifications/codex/channel", {
    id: channelMessageId,
    schema_version: 1,
    source: "telegram",
    channel: "telegram",
    text,
    attachments,
    sender: String(message.from?.id ?? chatId),
    sender_details: sender,
    bot: botIdentity,
    reply_to: replyTo,
    addressing,
    route: {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      key: routeKey(chatId, messageThreadId),
    },
    chat_id: chatId,
    message_thread_id: messageThreadId,
    telegram_message_id: message.message_id,
    username: message.from?.username,
    first_name: message.from?.first_name,
  });
}

async function ensureBotIdentity() {
  if (botIdentity || !token) {
    return botIdentity;
  }
  const me = await telegram("getMe", {});
  botIdentity = {
    id: String(me.id),
    username: me.username,
    first_name: me.first_name,
    can_join_groups: me.can_join_groups,
    can_read_all_group_messages: me.can_read_all_group_messages,
  };
  return botIdentity;
}

function summarizeTelegramUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: String(user.id),
    is_bot: Boolean(user.is_bot),
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    language_code: user.language_code,
  };
}

function summarizeReplyToMessage(message) {
  if (!message) {
    return null;
  }
  return {
    message_id: message.message_id,
    message_thread_id: message.message_thread_id,
    sender: summarizeTelegramUser(message.from),
    chat_id: message.chat?.id !== undefined ? String(message.chat.id) : undefined,
    text: message.text ?? message.caption,
    has_attachments: hasTelegramAttachment(message),
  };
}

function computeAddressing(message, text, replyTo) {
  const botId = botIdentity?.id;
  const botUsername = botIdentity?.username;
  const mentionedUsernames = mentionedUsernamesFromMessage(message);
  const command = commandFromMessage(message);
  const commandTarget = command?.target_username;
  const isPrivateChat = message.chat?.type === "private";
  const isReplyToBot = Boolean(botId && replyTo?.sender?.id === botId);
  const isReplyToOtherBot = Boolean(replyTo?.sender?.is_bot && !isReplyToBot);
  const mentionsBot = Boolean(
    botUsername
      && mentionedUsernames.some((username) => username.toLowerCase() === botUsername.toLowerCase()),
  );
  const commandToBot = Boolean(
    command
      && (isPrivateChat
        || (botUsername
          && commandTarget
          && commandTarget.toLowerCase() === botUsername.toLowerCase())),
  );
  const commandToOtherBot = Boolean(
    commandTarget
      && (!botUsername || commandTarget.toLowerCase() !== botUsername.toLowerCase()),
  );
  const probablyAddressedToBot = Boolean(
    isPrivateChat || isReplyToBot || mentionsBot || commandToBot,
  );

  return {
    bot_id: botId,
    bot_username: botUsername,
    chat_type: message.chat?.type,
    message_thread_id: message.message_thread_id,
    is_private_chat: isPrivateChat,
    is_reply: Boolean(replyTo),
    is_reply_to_bot: isReplyToBot,
    is_reply_to_other_bot: isReplyToOtherBot,
    mentioned_usernames: mentionedUsernames,
    mentions_bot: mentionsBot,
    command: command?.command,
    command_target_username: commandTarget,
    command_is_unqualified: Boolean(command && !commandTarget),
    command_to_bot: commandToBot,
    command_to_other_bot: commandToOtherBot,
    probably_addressed_to_bot: probablyAddressedToBot,
    text_starts_with_bot_mention: startsWithBotMention(text, botUsername),
  };
}

function mentionedUsernamesFromMessage(message) {
  const text = message.text ?? message.caption ?? "";
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  const usernames = [];
  for (const entity of entities) {
    if (entity.type !== "mention") {
      continue;
    }
    const mention = text.slice(entity.offset, entity.offset + entity.length);
    if (mention.startsWith("@")) {
      usernames.push(mention.slice(1));
    }
  }
  return usernames;
}

function commandFromMessage(message) {
  const text = message.text ?? "";
  const entities = message.entities ?? [];
  const commandEntity = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!commandEntity) {
    return null;
  }
  const token = text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length);
  const [command, target] = token.slice(1).split("@", 2);
  return {
    command,
    target_username: target,
  };
}

function startsWithBotMention(text, botUsername) {
  if (!botUsername) {
    return false;
  }
  return String(text ?? "").trimStart().toLowerCase().startsWith(`@${botUsername.toLowerCase()}`);
}

function hasTelegramAttachment(message) {
  return Boolean(
    message?.photo
      || message?.document
      || message?.animation
      || message?.video
      || message?.audio
      || message?.voice,
  );
}

async function collectTelegramAttachments(message, chatId) {
  const candidates = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    candidates.push({
      kind: "photo",
      file: photo,
      fileName: `telegram-${chatId}-${message.message_id}-photo.jpg`,
      mimeType: "image/jpeg",
    });
  }
  if (message.document) {
    candidates.push({
      kind: "document",
      file: message.document,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
    });
  }
  if (message.animation) {
    candidates.push({
      kind: "animation",
      file: message.animation,
      fileName: message.animation.file_name,
      mimeType: message.animation.mime_type,
    });
  }
  if (message.video) {
    candidates.push({
      kind: "video",
      file: message.video,
      fileName: message.video.file_name,
      mimeType: message.video.mime_type,
    });
  }
  if (message.audio) {
    candidates.push({
      kind: "audio",
      file: message.audio,
      fileName: message.audio.file_name,
      mimeType: message.audio.mime_type,
    });
  }
  if (message.voice) {
    candidates.push({
      kind: "voice",
      file: message.voice,
      fileName: `telegram-${chatId}-${message.message_id}-voice.ogg`,
      mimeType: message.voice.mime_type,
    });
  }

  const attachments = [];
  for (const candidate of candidates) {
    attachments.push(await downloadTelegramAttachment(candidate, chatId, message.message_id));
  }
  return attachments;
}

async function downloadTelegramAttachment(candidate, chatId, messageId) {
  const fileSize = candidate.file.file_size;
  const attachment = {
    kind: candidate.kind,
    file_id: candidate.file.file_id,
    file_unique_id: candidate.file.file_unique_id,
    file_name: candidate.fileName,
    mime_type: candidate.mimeType,
    file_size: fileSize,
  };
  if (Number.isFinite(fileSize) && fileSize > maxDownloadBytes) {
    attachment.download_error = `file too large: ${fileSize} > ${maxDownloadBytes}`;
    return attachment;
  }

  try {
    const file = await telegram("getFile", { file_id: candidate.file.file_id });
    attachment.path = await downloadTelegramFile(file.file_path, candidate, chatId, messageId);
  } catch (error) {
    attachment.download_error = error.message;
  }
  return attachment;
}

async function downloadTelegramFile(filePath, candidate, chatId, messageId) {
  const extension =
    path.extname(candidate.fileName ?? "") || path.extname(filePath ?? "") || ".bin";
  const baseName = sanitizeFileName(
    candidate.fileName ?? `telegram-${chatId}-${messageId}-${candidate.kind}${extension}`,
  );
  const target = path.join(downloadDir, `${Date.now()}-${baseName}`);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  } catch (error) {
    throw enrichFetchError("Telegram file download", error);
  }
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxDownloadBytes) {
    throw new Error(`file too large: ${buffer.length} > ${maxDownloadBytes}`);
  }
  await fs.mkdir(downloadDir, { recursive: true });
  await fs.writeFile(target, buffer, { mode: 0o600 });
  return target;
}

function defaultAttachmentText(attachments) {
  if (attachments.length === 0) {
    return "";
  }
  if (attachments.length === 1) {
    return `Telegram ${attachments[0].kind} attachment`;
  }
  return `Telegram message with ${attachments.length} attachments`;
}

async function sendChatActionFor(chatId, action, seconds, messageThreadId) {
  const until = Date.now() + seconds * 1000;
  do {
    await telegram("sendChatAction", chatActionPayload(chatId, action, messageThreadId));
    const remainingMs = until - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    await sleep(Math.min(4000, remainingMs));
  } while (Date.now() < until);
}

async function setTelegramReaction(chatId, messageId, emoji, isBig) {
  await telegram("setMessageReaction", reactionPayload(chatId, messageId, emoji, isBig));
}

function reactionPayload(chatId, messageId, emoji, isBig) {
  return {
    chat_id: chatId,
    message_id: messageId,
    reaction: [
      {
        type: "emoji",
        emoji,
      },
    ],
    is_big: isBig,
  };
}

async function tryTelegram(method, payload, context) {
  try {
    return await telegram(method, payload);
  } catch (error) {
    logError(`${context} failed: ${error.message}`);
    return null;
  }
}

function ignoreUpdate(reason) {
  ignoredUpdates += 1;
  lastIgnoredReason = reason;
}

function csvSet(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function threadIdSet(value) {
  const set = new Set();
  for (const entry of csvSet(value)) {
    const thread = normalizeThreadId(entry);
    if (thread === undefined) {
      configWarnings.push(`ignored invalid TELEGRAM_ALLOWED_THREAD_IDS entry: ${entry}`);
      continue;
    }
    set.add(String(thread));
  }
  return set;
}

function routeSet(value) {
  const set = new Set();
  for (const entry of csvSet(value)) {
    const normalized = normalizeRouteEntry(entry);
    if (!normalized) {
      configWarnings.push(`ignored invalid TELEGRAM_ALLOWED_ROUTES entry: ${entry}`);
      continue;
    }
    set.add(normalized);
  }
  return set;
}

function normalizeRouteEntry(entry) {
  const index = entry.lastIndexOf(":");
  if (index === -1) {
    return entry;
  }
  const chatId = entry.slice(0, index).trim();
  const threadId = entry.slice(index + 1).trim();
  if (!chatId) {
    return null;
  }
  if (threadId === "*") {
    return `${chatId}:*`;
  }
  const thread = normalizeThreadId(threadId);
  return thread === undefined ? null : routeKey(chatId, thread);
}

function parseIntegerEnv(name, defaultValue, options) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    configWarnings.push(
      `ignored invalid ${name}=${raw}; using ${defaultValue} (${options.min}-${options.max})`,
    );
    return defaultValue;
  }
  return value;
}

function chatAllowed(chatId, messageThreadId) {
  return chatAllowedWithSets(chatId, messageThreadId, {
    allowAllChats,
    allowedChatIds,
    allowedThreadIds,
    allowedRoutes,
  });
}

function chatAllowedWithSets(chatId, messageThreadId, config) {
  if (config.allowAllChats) {
    return true;
  }
  const chat = String(chatId);
  const thread = normalizeThreadId(messageThreadId);
  const routes = config.allowedRoutes ?? new Set();
  if (
    routes.has(routeKey(chat, thread))
    || routes.has(`${chat}:*`)
    || (!thread && routes.has(chat))
  ) {
    return true;
  }
  if (!config.allowedChatIds?.has(chat)) {
    return false;
  }
  const threads = config.allowedThreadIds ?? new Set();
  return threads.size === 0 || (thread !== undefined && threads.has(String(thread)));
}

function chatActionPayload(chatId, action, messageThreadId) {
  return {
    chat_id: chatId,
    action,
    ...threadPayload(messageThreadId),
  };
}

function threadPayload(messageThreadId) {
  const thread = normalizeThreadId(messageThreadId);
  return thread === undefined ? {} : { message_thread_id: thread };
}

function normalizeThreadId(messageThreadId) {
  if (messageThreadId === undefined || messageThreadId === null || messageThreadId === "") {
    return undefined;
  }
  const number = Number(messageThreadId);
  return Number.isSafeInteger(number) ? number : undefined;
}

function routeKey(chatId, messageThreadId) {
  const thread = normalizeThreadId(messageThreadId);
  return thread === undefined ? String(chatId) : `${chatId}:${thread}`;
}

async function telegram(method, payload) {
  let attempt = 0;
  for (;;) {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw enrichFetchError(`Telegram API ${method}`, error);
    }
    const json = await response.json().catch(() => null);
    if (response.ok && json?.ok) {
      return json.result;
    }

    const retryAfter = json?.parameters?.retry_after;
    const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      attempt += 1;
      await sleep(retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }

    const error = new Error(json?.description ?? `Telegram API ${method} failed`);
    if (retryAfterMs !== undefined) {
      error.retryAfterMs = retryAfterMs;
    }
    throw error;
  }
}

async function telegramMultipart(method, fields, fileField, filePath) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  const blob = await openAsBlob(filePath);
  form.append(fileField, blob, path.basename(filePath));
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: form,
    });
  } catch (error) {
    throw enrichFetchError(`Telegram API ${method}`, error);
  }
  const json = await response.json().catch(() => null);
  if (response.ok && json?.ok) {
    return json.result;
  }
  throw new Error(json?.description ?? `Telegram API ${method} failed`);
}

function enrichFetchError(context, error) {
  const enriched = new Error(`${context} fetch failed: ${describeError(error)}`);
  enriched.cause = error;
  return enriched;
}

function describeError(error) {
  const parts = [error?.message ?? String(error)];
  const cause = error?.cause;
  if (cause) {
    const causeParts = [];
    if (cause.code) {
      causeParts.push(`code=${cause.code}`);
    }
    if (cause.errno) {
      causeParts.push(`errno=${cause.errno}`);
    }
    if (cause.syscall) {
      causeParts.push(`syscall=${cause.syscall}`);
    }
    if (cause.hostname) {
      causeParts.push(`hostname=${cause.hostname}`);
    }
    if (cause.address) {
      causeParts.push(`address=${cause.address}`);
    }
    if (cause.port) {
      causeParts.push(`port=${cause.port}`);
    }
    if (cause.message && cause.message !== error.message) {
      causeParts.push(cause.message);
    }
    if (causeParts.length > 0) {
      parts.push(`cause(${causeParts.join(", ")})`);
    }
  }
  return parts.join(" ");
}

async function routeForReply(args) {
  const id = String(args.channel_message_id ?? "").trim();
  if (!id) {
    return {};
  }
  return recentMessages.get(id) ?? (await routeFromCache(id)) ?? routeFromChannelMessageId(id) ?? {};
}

async function resolveTelegramRoute(args) {
  const explicitChatId = args.chat_id !== undefined && args.chat_id !== null;
  if (explicitChatId) {
    return {
      chatId: String(args.chat_id).trim(),
      messageThreadId: args.message_thread_id,
    };
  }

  const route = await routeForReply(args);
  return {
    ...route,
    chatId: String(route.chatId ?? lastChatId ?? "").trim(),
    messageThreadId: args.message_thread_id ?? route.messageThreadId ?? lastMessageThreadId,
  };
}

async function rememberMessage(id, route) {
  recentMessages.set(id, route);
  while (recentMessages.size > 200) {
    const oldest = recentMessages.keys().next().value;
    recentMessages.delete(oldest);
  }
  await writeRouteCache();
}

async function routeFromCache(id) {
  const raw = await fs.readFile(routeCacheFile, "utf8").catch(() => "");
  const cache = safeJsonParse(raw);
  const route = cache?.routes?.[id];
  return route && typeof route === "object" ? route : null;
}

async function writeRouteCache() {
  await fs.mkdir(path.dirname(routeCacheFile), { recursive: true });
  const routes = Object.fromEntries(recentMessages.entries());
  const tmp = `${routeCacheFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ routes })}\n`, { mode: 0o600 });
  await fs.rename(tmp, routeCacheFile);
}

function routeFromChannelMessageId(id) {
  const match = /^telegram:(.+):(\d+)$/.exec(id);
  if (!match) {
    return null;
  }
  const messageId = Number(match[2]);
  return {
    chatId: match[1],
    messageId,
    replyToMessageId: messageId,
  };
}

function splitTelegramMessage(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxTelegramMessageLength) {
    chunks.push(text.slice(offset, offset + maxTelegramMessageLength));
  }
  return chunks.length === 0 ? [""] : chunks;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function sanitizeFileName(value) {
  const sanitized = String(value)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "telegram-file.bin";
}

async function readOffset() {
  try {
    const data = JSON.parse(await fs.readFile(offsetFile, "utf8"));
    return Number.isSafeInteger(data?.offset) && data.offset > 0 ? data.offset : 0;
  } catch (error) {
    if (error.code !== "ENOENT") {
      logError(`failed to read Telegram offset file: ${error.message}`);
    }
    return 0;
  }
}

async function writeOffset(offset) {
  await fs.mkdir(path.dirname(offsetFile), { recursive: true });
  const tmp = `${offsetFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ offset })}\n`, { mode: 0o600 });
  await fs.rename(tmp, offsetFile);
}

function statusText() {
  const lines = [
    `polling=${polling}`,
    `polling_wait_reason=${pollingWaitReason() ?? "none"}`,
    `channel_consumer=${channelConsumerAvailable ? "available" : "unavailable"}`,
    "channel_delivery=custom_notification_v1",
    `debug=${telegramDebug}`,
    `poll_lock=${pollLockStatus}`,
    `poll_lock_file=${pollLockFile}`,
    `allow_all_chats=${allowAllChats}`,
    `allowed_chats=${allowedChatIds.size}`,
    `allowed_threads=${allowedThreadIds.size}`,
    `allowed_routes=${allowedRoutes.size}`,
    `offset=${updateOffset}`,
    `accepted_updates=${acceptedUpdates}`,
    `rejected_updates=${rejectedUpdates}`,
    `ignored_updates=${ignoredUpdates}`,
    `recent_routes=${recentMessages.size}`,
    `offset_file=${offsetFile}`,
    `route_cache_file=${routeCacheFile}`,
    `download_dir=${downloadDir}`,
    `bot_username=${botIdentity?.username ?? "unknown"}`,
    `bot_id=${botIdentity?.id ?? "unknown"}`,
  ];
  if (configWarnings.length > 0) {
    lines.push(`config_warnings=${configWarnings.length}`);
  }

  if (telegramDebug) {
    lines.push(
      `seen_updates=${seenUpdates}`,
      `last_ignored_reason=${lastIgnoredReason}`,
      `last_update=${lastUpdateSummary}`,
      ...configWarnings.map((warning) => `config_warning=${warning}`),
    );
  }

  return lines.join("\n");
}

function logConfigWarnings() {
  for (const warning of configWarnings) {
    logError(warning);
  }
}

function summarizeUpdate(update) {
  const message = update.message ?? update.edited_message ?? update.channel_post;
  const keys = Object.keys(update).join(",");
  if (!message) {
    return `update_id=${update.update_id};keys=${keys}`;
  }
  const messageKeys = Object.keys(message).join(",");
  return [
    `update_id=${update.update_id}`,
    `keys=${keys}`,
    `chat_id=${message.chat?.id ?? "none"}`,
    `message_thread_id=${message.message_thread_id ?? "none"}`,
    `message_id=${message.message_id ?? "none"}`,
    `message_keys=${messageKeys}`,
    `has_text=${Boolean(message.text)}`,
    `has_caption=${Boolean(message.caption)}`,
  ].join(";");
}

async function runSelfTest() {
  if (
    !supportsChannelNotifications({
      capabilities: {
        experimental: { "codex/channel-notifications": { schemaVersion: 1 } },
      },
    })
    || supportsChannelNotifications({ capabilities: { experimental: {} } })
    || supportsChannelNotifications({
      capabilities: {
        experimental: { "codex/channel-notifications": { schemaVersion: 2 } },
      },
    })
  ) {
    throw new Error("supportsChannelNotifications self-test failed");
  }
  let pollingStarts = 0;
  const startProbe = () => {
    pollingStarts += 1;
  };
  const readyState = {
    polling: false,
    initialized: true,
    channelConsumerAvailable: true,
    hasToken: true,
    hasAllowedRoutes: true,
  };
  if (
    maybeStartPolling({ ...readyState, channelConsumerAvailable: false }, startProbe)
    || maybeStartPolling({ ...readyState, hasToken: false }, startProbe)
    || maybeStartPolling({ ...readyState, hasAllowedRoutes: false }, startProbe)
    || !maybeStartPolling(readyState, startProbe)
    || pollingStarts !== 1
  ) {
    throw new Error("polling capability gate self-test failed");
  }
  const chunks = splitTelegramMessage("x".repeat(maxTelegramMessageLength + 2));
  if (chunks.length !== 2 || chunks[0].length !== maxTelegramMessageLength || chunks[1].length !== 2) {
    throw new Error("splitTelegramMessage self-test failed");
  }
  await rememberMessage("telegram:1:2", { chatId: "1", messageId: 2, replyToMessageId: 2, messageThreadId: 10 });
  const route = await routeForReply({ channel_message_id: "telegram:1:2" });
  if (route.chatId !== "1" || route.messageId !== 2 || route.replyToMessageId !== 2 || route.messageThreadId !== 10) {
    throw new Error("routeForReply self-test failed");
  }
  lastChatId = "2";
  lastMessageThreadId = 99;
  const explicitRoute = await resolveTelegramRoute({ chat_id: "3" });
  if (explicitRoute.chatId !== "3" || explicitRoute.messageThreadId !== undefined) {
    throw new Error("resolveTelegramRoute explicit chat self-test failed");
  }
  const rememberedRoute = await resolveTelegramRoute({ channel_message_id: "telegram:1:2" });
  if (rememberedRoute.chatId !== "1" || rememberedRoute.messageThreadId !== 10) {
    throw new Error("resolveTelegramRoute remembered self-test failed");
  }
  const parsedRoute = await resolveTelegramRoute({ channel_message_id: "telegram:-1001:22" });
  if (parsedRoute.chatId !== "-1001" || parsedRoute.messageId !== 22 || parsedRoute.replyToMessageId !== 22) {
    throw new Error("resolveTelegramRoute parsed channel id self-test failed");
  }
  const fallbackRoute = await resolveTelegramRoute({});
  if (fallbackRoute.chatId !== "2" || fallbackRoute.messageThreadId !== 99) {
    throw new Error("resolveTelegramRoute fallback self-test failed");
  }
  if (!chatAllowedWithSets("-1001", 10, {
    allowAllChats: false,
    allowedChatIds: new Set(["-1001"]),
    allowedThreadIds: new Set(["10"]),
    allowedRoutes: new Set(),
  })) {
    throw new Error("allowed thread self-test failed");
  }
  if (!chatAllowedWithSets("-1001", 20, {
    allowAllChats: false,
    allowedChatIds: new Set(),
    allowedThreadIds: new Set(),
    allowedRoutes: new Set(["-1001:20"]),
  })) {
    throw new Error("allowed route self-test failed");
  }
  if (chatAllowedWithSets("-1001", 21, {
    allowAllChats: false,
    allowedChatIds: new Set(),
    allowedThreadIds: new Set(),
    allowedRoutes: new Set(["-1001:20"]),
  })) {
    throw new Error("rejected route self-test failed");
  }
  if (!chatAllowedWithSets("42", undefined, {
    allowAllChats: false,
    allowedChatIds: new Set(["42"]),
    allowedThreadIds: new Set(),
    allowedRoutes: new Set(["-1001:20"]),
  })) {
    throw new Error("allowed chat fallback self-test failed");
  }
  if (normalizeRouteEntry("-1001:*") !== "-1001:*" || normalizeRouteEntry("-1001:020") !== "-1001:20") {
    throw new Error("normalizeRouteEntry self-test failed");
  }
  const warningsBefore = configWarnings.length;
  if (routeSet("-1001:20,bad:thread").size !== 1 || configWarnings.length !== warningsBefore + 1) {
    throw new Error("routeSet warning self-test failed");
  }
  if (threadIdSet("1,nope,2").size !== 2 || configWarnings.length !== warningsBefore + 2) {
    throw new Error("threadIdSet warning self-test failed");
  }
  const reaction = reactionPayload("1", 2, "👀", false);
  if (reaction.reaction[0].emoji !== "👀" || reaction.message_id !== 2) {
    throw new Error("reactionPayload self-test failed");
  }
  if (clampInteger(99, 1, 30) !== 30 || clampInteger("bad", 1, 30) !== 1) {
    throw new Error("clampInteger self-test failed");
  }
  if (sanitizeFileName("../bad:name.png") !== "..-bad-name.png") {
    throw new Error("sanitizeFileName self-test failed");
  }
  if (parseProcStatParentPid("123 (telegram channel) S 456 0 0 0") !== 456) {
    throw new Error("parseProcStatParentPid self-test failed");
  }
  botIdentity = { id: "42", username: "syncera_research_bot" };
  const addressed = computeAddressing(
    {
      chat: { type: "supergroup" },
      text: "/ping@syncera_research_bot",
      entities: [{ type: "bot_command", offset: 0, length: 26 }],
    },
    "/ping@syncera_research_bot",
    null,
  );
  if (!addressed.command_to_bot || !addressed.probably_addressed_to_bot) {
    throw new Error("computeAddressing command self-test failed");
  }
  const unqualifiedGroupCommand = computeAddressing(
    {
      chat: { type: "supergroup" },
      text: "/ping",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    },
    "/ping",
    null,
  );
  if (!unqualifiedGroupCommand.command_is_unqualified || unqualifiedGroupCommand.command_to_bot) {
    throw new Error("computeAddressing unqualified group command self-test failed");
  }
  const replyToOtherBot = computeAddressing(
    { chat: { type: "supergroup" }, text: "не тебе" },
    "не тебе",
    { sender: { id: "100", is_bot: true } },
  );
  if (!replyToOtherBot.is_reply_to_other_bot || replyToOtherBot.probably_addressed_to_bot) {
    throw new Error("computeAddressing other bot reply self-test failed");
  }
  const status = statusText();
  if (!status.includes("channel_delivery=custom_notification_v1")) {
    throw new Error("custom notification delivery self-test failed");
  }
  const hasDebugStatus = status.includes("last_update=");
  if (hasDebugStatus !== telegramDebug) {
    throw new Error("telegram_status debug gating self-test failed");
  }
}

function sendResult(id, result) {
  write({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  write({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function sendNotification(method, params) {
  write({
    jsonrpc: "2.0",
    method,
    params,
  });
}

function sendChannelNotification(method, params) {
  sendNotification(method, params);
}

function logError(message) {
  sendNotification("notifications/message", {
    level: "error",
    logger: "telegram-channel",
    data: message,
  });
}

function logInfo(message) {
  sendNotification("notifications/message", {
    level: "info",
    logger: "telegram-channel",
    data: message,
  });
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
