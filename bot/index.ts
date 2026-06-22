/**
 * Discord Gateway bridge for the Makroify Eve agent.
 *
 * Eve's built-in Discord channel only receives interactions (slash commands).
 * To let a team just *chat* in a channel ("we need sugar"), this thin bridge
 * connects to the Discord Gateway (WebSocket, Message Content intent), forwards
 * each message to the SAME Eve agent over its local HTTP API, posts the reply,
 * and reacts ✅ when the agent actually changes the cart.
 *
 * It holds no business logic — Eve stays the single brain. Run it alongside
 * `eve dev` (or a deployed Eve URL):  npm run bot
 */
import { Client, Events, GatewayIntentBits, Partials, type SendableChannels } from "discord.js";

try {
  process.loadEnvFile?.();
} catch {
  /* rely on real env */
}

const EVE_BASE = process.env.EVE_BASE_URL ?? "http://127.0.0.1:2000";
const WATCH_CHANNEL_ID = process.env.DISCORD_WATCH_CHANNEL_ID; // optional
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const IDLE_RESET_MS = 30 * 60_000; // start a fresh conversation after 30 min quiet

if (!BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

interface ChannelSession {
  sessionId: string;
  continuationToken: string;
  lastActivity: number;
}
const sessions = new Map<string, ChannelSession>();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  console.log(`[bot] eve: ${EVE_BASE} | watching: ${WATCH_CHANNEL_ID ?? "(mentions only)"}`);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.content) return;
  const mentioned = client.user ? msg.mentions.users.has(client.user.id) : false;
  const inWatched = WATCH_CHANNEL_ID ? msg.channelId === WATCH_CHANNEL_ID : false;
  if (!mentioned && !inWatched) return;

  const text = msg.content.replace(/<@!?\d+>/g, "").trim();
  if (!text || !msg.channel.isSendable()) return;
  const channel = msg.channel;

  try {
    await channel.sendTyping().catch(() => {});
    const { reply, cartChanged } = await askEve(msg.channelId, text);
    if (reply) await replyInChunks(channel, reply);
    if (cartChanged) await msg.react("✅").catch(() => {});
  } catch (err) {
    console.error("[bot] turn failed:", err);
    await msg.reply("⚠️ Coś poszło nie tak po stronie bota. Spróbuj ponownie za chwilę.").catch(() => {});
  }
});

/** Send a message to the Eve agent (new or continued session) and read the turn. */
async function askEve(channelId: string, message: string): Promise<{ reply: string; cartChanged: boolean }> {
  const now = Date.now();
  const prev = sessions.get(channelId);
  const fresh = !prev || now - prev.lastActivity > IDLE_RESET_MS;

  let sessionId: string;
  try {
    if (fresh) {
      const r = await postJson(`${EVE_BASE}/eve/v1/session`, { message });
      sessionId = r.sessionId;
      sessions.set(channelId, { sessionId, continuationToken: r.continuationToken, lastActivity: now });
    } else {
      sessionId = prev!.sessionId;
      const r = await postJson(`${EVE_BASE}/eve/v1/session/${sessionId}`, {
        continuationToken: prev!.continuationToken,
        message,
      });
      sessions.set(channelId, { sessionId, continuationToken: r.continuationToken, lastActivity: now });
    }
  } catch (e) {
    // Continuation token likely stale — restart the conversation once.
    const r = await postJson(`${EVE_BASE}/eve/v1/session`, { message });
    sessionId = r.sessionId;
    sessions.set(channelId, { sessionId, continuationToken: r.continuationToken, lastActivity: now });
  }

  const turn = await readTurn(sessionId);
  sessions.set(channelId, {
    sessionId,
    continuationToken: turn.continuationToken ?? sessions.get(channelId)!.continuationToken,
    lastActivity: Date.now(),
  });
  return { reply: turn.reply, cartChanged: turn.cartChanged };
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json();
}

const CART_TOOLS = ["makro_add_to_cart", "makro_update_quantity", "makro_remove_from_cart"];

/** Stream a turn's SSE events: collect the final reply + detect a cart change. */
async function readTurn(sessionId: string): Promise<{ reply: string; cartChanged: boolean; continuationToken?: string }> {
  const res = await fetch(`${EVE_BASE}/eve/v1/session/${sessionId}/stream`, {
    headers: { accept: "text/event-stream" },
  });
  if (!res.body) return { reply: "", cartChanged: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const messages: string[] = [];
  let cartChanged = false;
  let continuationToken: string | undefined;

  const handleLine = (line: string) => {
    let s = line.trim();
    if (!s) return;
    if (s.startsWith("data:")) s = s.slice(5).trim();
    if (!s.startsWith("{")) return;
    let evt: any;
    try {
      evt = JSON.parse(s);
    } catch {
      return;
    }
    const data = evt?.data ?? {};
    if (evt.type === "message.completed" && data.finishReason !== "tool-calls" && typeof data.message === "string") {
      if (data.message.trim()) messages.push(data.message.trim());
    }
    if (typeof data.continuationToken === "string") continuationToken = data.continuationToken;
    // Detect a successful cart mutation anywhere in this event.
    if (CART_TOOLS.some((t) => s.includes(t)) && s.includes('"ok":true')) cartChanged = true;
  };

  let done = false;
  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
      if (line.includes('"session.waiting"') || line.includes('"session.completed"') || line.includes('"turn.failed"')) {
        done = true;
      }
    }
  }
  if (buf) handleLine(buf);
  await reader.cancel().catch(() => {});

  // Use the last non-empty assistant message as the reply.
  const reply = messages.length ? messages[messages.length - 1]! : "";
  return { reply, cartChanged, continuationToken };
}

/** Discord caps messages at 2000 chars — split on line boundaries. */
async function replyInChunks(channel: SendableChannels, text: string): Promise<void> {
  const LIMIT = 1900;
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > LIMIT) {
      if (cur) parts.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) parts.push(cur);
  for (const part of parts) await channel.send(part);
}

client.login(BOT_TOKEN);
