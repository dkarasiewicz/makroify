/**
 * Discord Gateway bridge for the Makroify Eve agent.
 *
 * Eve's built-in Discord channel only receives interactions (slash commands).
 * To let a team just *chat* in a channel ("we need sugar"), this thin bridge
 * connects to the Discord Gateway (WebSocket, Message Content intent), forwards
 * each message to the SAME Eve agent over its local HTTP API, posts the reply,
 * and reacts ✅ when the agent actually changes the cart.
 *
 * It holds no business logic — Eve stays the single brain. Multi-tenant routing
 * lives in ./tenants.ts. Run alongside `eve dev` (or a deployed Eve):  npm run bot
 */
import { Client, Events, GatewayIntentBits, Partials, type SendableChannels } from "discord.js";
import { listTenants, tenantForChannel, tenantForGuild, type Tenant } from "./tenants";

try {
  process.loadEnvFile?.();
} catch {
  /* rely on real env */
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const IDLE_RESET_MS = 30 * 60_000; // start a fresh conversation after 30 min quiet
const TURN_TIMEOUT_MS = 90_000;

// Daily cart-review reminder.
const TZ = "Europe/Warsaw";
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR_WARSAW ?? 20); // 20:00 PL

if (!BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

/** Per (tenant + channel) Eve conversation. */
interface Conversation {
  sessionId: string;
  /** From `create` — reused on EVERY continue (Eve never re-issues it). */
  continuationToken: string;
  /** Number of turns sent (used to extract the right turn from the replay stream). */
  turns: number;
  lastActivity: number;
}
const conversations = new Map<string, Conversation>();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  for (const t of listTenants()) {
    console.log(`[bot] tenant=${t.id} eve=${t.eveBaseUrl} watch=[${t.watchChannelIds.join(",")}] reminder=${t.reminderChannelId ?? "-"}`);
  }
  startReminderScheduler();
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const mentioned = client.user ? msg.mentions.users.has(client.user.id) : false;
  const tenant = tenantForChannel(msg.channelId) ?? (mentioned ? tenantForGuild(msg.guildId) : undefined);
  console.log(
    `[bot] msg ch=${msg.channelId} from=${msg.author.username} len=${msg.content.length} tenant=${tenant?.id ?? "-"} mentioned=${mentioned}`,
  );
  if (!tenant || !msg.content || !msg.channel.isSendable()) return;
  const channel = msg.channel;

  try {
    await channel.sendTyping().catch(() => {});
    const { reply, cartChanged } = await askEve(tenant, msg.channelId, msg.content.replace(/<@!?\d+>/g, "").trim());
    if (reply) await replyInChunks(channel, reply);
    if (cartChanged) await msg.react("✅").catch(() => {});
  } catch (err) {
    console.error("[bot] turn failed:", err);
    await msg.reply("⚠️ Coś poszło nie tak po stronie bota. Spróbuj ponownie za chwilę.").catch(() => {});
  }
});

// --- Eve session bridge ---

const CART_TOOLS = ["makro_add_to_cart", "makro_update_quantity", "makro_remove_from_cart"];

async function askEve(tenant: Tenant, channelId: string, message: string): Promise<{ reply: string; cartChanged: boolean }> {
  if (!message) return { reply: "", cartChanged: false };
  const key = `${tenant.id}:${channelId}`;
  const now = Date.now();
  const prev = conversations.get(key);
  const fresh = !prev || now - prev.lastActivity > IDLE_RESET_MS;

  let convo: Conversation;
  if (fresh) {
    convo = await createSession(tenant, message);
  } else {
    try {
      await postJson(`${tenant.eveBaseUrl}/eve/v1/session/${prev!.sessionId}`, {
        continuationToken: prev!.continuationToken,
        message,
      });
      convo = { ...prev!, turns: prev!.turns + 1, lastActivity: now };
    } catch {
      convo = await createSession(tenant, message); // stale session — restart
    }
  }
  conversations.set(key, convo);

  const turn = await readTurn(tenant, convo.sessionId, convo.turns);
  convo.lastActivity = Date.now();
  conversations.set(key, convo);
  return turn;
}

async function createSession(tenant: Tenant, message: string): Promise<Conversation> {
  const r = await postJson(`${tenant.eveBaseUrl}/eve/v1/session`, { message });
  return { sessionId: r.sessionId, continuationToken: r.continuationToken, turns: 1, lastActivity: Date.now() };
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

/**
 * Read ONLY the `turnIndex`-th turn from the session's (full-history) replay
 * stream. The stream replays every prior turn — each ending in `session.waiting`
 * — so we skip the first `turnIndex - 1` of them, collect the target turn, and
 * stop at its `session.waiting`. Cart detection is scoped to the target turn.
 */
async function readTurn(tenant: Tenant, sessionId: string, turnIndex: number): Promise<{ reply: string; cartChanged: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);
  try {
    const res = await fetch(`${tenant.eveBaseUrl}/eve/v1/session/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    if (!res.body) return { reply: "", cartChanged: false };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let waitingSeen = 0;
    let collecting = turnIndex === 1;
    const messages: string[] = [];
    let cartChanged = false;
    let done = false;

    const handle = (raw: string): boolean => {
      let s = raw.trim();
      if (!s) return false;
      if (s.startsWith("data:")) s = s.slice(5).trim();
      if (!s.startsWith("{")) return false;
      let evt: any;
      try {
        evt = JSON.parse(s);
      } catch {
        return false;
      }
      if (evt.type === "session.waiting") {
        if (collecting) return true; // target turn finished
        waitingSeen += 1;
        if (waitingSeen === turnIndex - 1) collecting = true; // target turn starts next
        return false;
      }
      if (!collecting) return false;
      const d = evt.data ?? {};
      if (evt.type === "message.completed" && d.finishReason !== "tool-calls" && typeof d.message === "string" && d.message.trim()) {
        messages.push(d.message.trim());
      }
      if (CART_TOOLS.some((t) => s.includes(t)) && s.includes('"ok":true')) cartChanged = true;
      return false;
    };

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (handle(line)) {
          done = true;
          break;
        }
      }
    }
    if (!done && buf) handle(buf);
    await reader.cancel().catch(() => {});
    return { reply: messages.length ? messages[messages.length - 1]! : "", cartChanged };
  } finally {
    clearTimeout(timer);
  }
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

// --- Daily 20:00 (Europe/Warsaw) cart-review reminder ---

function warsawNow(): { hour: number; minute: number; date: string; dow: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { hour: Number(get("hour")), minute: Number(get("minute")), date, dow };
}

/** Order before 21:00 → next day, but never Sunday (→ Monday). */
function deliveryInfo(): string {
  const { date, dow } = warsawNow();
  const base = new Date(`${date}T12:00:00Z`);
  const daysAhead = (dow + 1) % 7 === 0 ? 2 : 1; // tomorrow is Sunday → Monday
  const del = new Date(base);
  del.setUTCDate(base.getUTCDate() + daysAhead);
  const when = new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(del);
  return `Jeśli złożymy zamówienie dziś do 21:00, dostawa będzie w ${when}. (W niedziele nie ma dostaw.)`;
}

async function sendReminderFor(tenant: Tenant): Promise<void> {
  if (!tenant.reminderChannelId) return;
  const channel = await client.channels.fetch(tenant.reminderChannelId).catch(() => null);
  if (!channel?.isSendable()) {
    console.warn(`[bot] reminder skipped for ${tenant.id}: channel not sendable`);
    return;
  }
  const prompt =
    "To jest codzienne przypomnienie o 20:00. Pokaż aktualną zawartość koszyka Makro " +
    "(pozycje z ilościami i łączną kwotę brutto). Następnie zapytaj, czy mamy złożyć zamówienie. " +
    "Dołącz dokładnie tę informację o dostawie: " +
    deliveryInfo() +
    " Odpowiedz po polsku, zwięźle.";
  const r = await postJson(`${tenant.eveBaseUrl}/eve/v1/session`, { message: prompt });
  const { reply } = await readTurn(tenant, r.sessionId, 1);
  await replyInChunks(channel, `🛒 **Przypomnienie o koszyku (20:00)**\n${reply || "(nie udało się pobrać koszyka)"}`);
}

function startReminderScheduler(): void {
  let lastFiredDate = "";
  const tick = () => {
    const { hour, minute, date } = warsawNow();
    if (hour === REMINDER_HOUR && minute === 0 && lastFiredDate !== date) {
      lastFiredDate = date;
      console.log(`[bot] firing daily reminder for ${date}`);
      for (const t of listTenants()) sendReminderFor(t).catch((e) => console.error(`[bot] reminder failed (${t.id}):`, e));
    }
  };
  setInterval(tick, 60_000);
  console.log(`[bot] daily reminder scheduled for ${REMINDER_HOUR}:00 ${TZ}`);
}

client.login(BOT_TOKEN);
