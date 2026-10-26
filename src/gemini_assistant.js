const axios = require("axios");
const https = require("https");

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  Buffer.from("QVEuQWI4Uk42Sl9ZQ3Z2QlFaVnZ2dlBsVTNXVnNvWGJWQUVtZnhjcU9xR1V1UllTR0VBb1E=", "base64").toString("utf-8");

// Candidate models in cascade order: ultra-fast 3.5 Flash Lite & 3.6 Flash
const CANDIDATE_MODELS = [
  { name: "gemini-3.5-flash-lite", timeout: 12000 },
  { name: "gemini-3.6-flash", timeout: 12000 },
  { name: "gemini-flash-lite-latest", timeout: 12000 },
  { name: "gemini-2.5-flash", timeout: 4000 },
];

// Official FilmFeed Website
const OFFICIAL_WEBSITE = "https://web-umber-six-e1un7z6257.vercel.app";

// Use IPv4 first agent to ensure ultra-fast DNS resolution
const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
});

// Cooldown tracker: phone -> timestamp
const userCooldowns = new Map();
// Conversation history: phone -> array of { role, parts }
const userHistories = new Map();

const COOLDOWN_MS = 4 * 1000; // 4 seconds cooldown per user
const MAX_HISTORY_TURNS = 8; // Keep up to 8 turns (4 user, 4 assistant)

const AKASH_VCARD =
  "BEGIN:VCARD\n" +
  "VERSION:3.0\n" +
  "FN:Akash Sithum\n" +
  "ORG:FilmFeed Creator & Developer;\n" +
  "TEL;type=CELL;type=VOICE;waid=94787732040:+94 78 773 2040\n" +
  "END:VCARD";

/**
 * Fast check for developer/identity queries
 */
function isIdentityQuery(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  const patterns = [
    /\b(oya|oyaa|oyala|ubala|uba)\s+(kawu?da|kavuda|kauda)\b/i,
    /\b(kawu?da|kauda|kavuda)\s+(me|oya|oyaa|uba|bn)\b/i,
    /\b(oya|oyaa)\s+(bot\s*kenekda|botda|mokakda|human\s*da|ai\s*da|kellekda|kollekda)\b/i,
    /\b(mona|monawada)\s+bot\b/i,
    /\b(who\s*are\s*you|are\s*you\s*(a\s*)?bot|what\s*bot|who\s*is\s*this|your\s*name)\b/i,
    /\b(haduwe\s*kawuda|hadapu\s*kena|owner|creator|developer|akash|sithum|admin\s*kauda|admin\s*number|admin|0787732040|94787732040)\b/i,
    /\b(senu|senuri)\b/i,
    /ඔයා\s*(කවුද|බොට්|මොන|කෙල්ලෙක්ද)/,
    /(කවුද\s*මේ|කවුද\s*ඔයා|හැදුවේ\s*කවුද|නිර්මාණය|අයිතිකරු|ඇඩ්මින්|ආකාශ්|සිතුම්|සෙනූ)/,
  ];
  return patterns.some((p) => p.test(lower));
}

/**
 * Fast keyword & regex check to ensure personal/private chats aren't answered
 */
function isMovieRelatedQuery(text) {
  if (!text) return false;
  if (isIdentityQuery(text)) return true;

  const lower = text.toLowerCase().trim();

  // Common keywords in English / Singlish
  const keywords = [
    "movie", "film", "flim", "cinesub", "cinesubz", "sinhalasub", "baiscope", "sub", "subtitle",
    "download", "downlod", "ganna", "ganne", "kohomada", "link", "group", "bot",
    "one", "ona", "oni", "denna", "ewanna", "evanna", "balanna", "balapu", "req", "request",
    "series", "season", "episode", "ep", "tamil", "hindi", "english", "korean", "anime", "malayalam", "telugu",
    "hd", "4k", "720p", "1080p", "help", "hi", "hello", "hey", "ai", "oyaa", "oya", "machan", "mchn", "bro", "aiye", "ayye",
    "filmfeed", "nexus", "admin", "puluwanda", "danna", "mokakda", "mokada", "ko", "koo", "kawda", "kauda",
    "done", "verify", "join", "pack", "password", "settings", "site", "web", "website", "file", "senu"
  ];

  const hasKeyword = keywords.some((k) => lower.includes(k));
  // Sinhala unicode block check (U+0D80 to U+0DFF)
  const hasSinhala = /[\u0D80-\u0DFF]/.test(text);

  return hasKeyword || hasSinhala;
}

/**
 * Call Gemini API with cascade fallback across models
 */
async function callGeminiCascade(systemInstruction, history, maxTokens = 300) {
  for (const item of CANDIDATE_MODELS) {
    const model = item.name;
    const timeout = item.timeout || 7000;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const payload = {
        system_instruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: history,
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: maxTokens,
        },
      };

      const res = await axios.post(url, payload, {
        httpsAgent,
        timeout,
        headers: { "Content-Type": "application/json" },
      });

      const replyText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      if (replyText) {
        return { replyText, modelUsed: model };
      }
    } catch (err) {
      console.warn(`[Gemini Assistant - Senu] Model ${model} failed: ${err.message}. Cascading...`);
    }
  }
  return null;
}

/**
 * Handle incoming direct inbox message and generate smart friendly Sinhala reply
 * Returns { text: string, sendContactCard: boolean, contact: object|null } or null if personal conversation
 */
async function handleInboxAutoReply(senderPhone, pushName, userMessage, primaryGroupLink) {
  if (!userMessage || !userMessage.trim()) return null;

  // 1. First-pass intent filtering
  if (!isMovieRelatedQuery(userMessage)) {
    return null;
  }

  // 2. Cooldown check
  const now = Date.now();
  const lastReply = userCooldowns.get(senderPhone) || 0;
  if (now - lastReply < COOLDOWN_MS) {
    return null;
  }

  const groupLink = primaryGroupLink && primaryGroupLink !== "https://chat.whatsapp.com/invite"
    ? primaryGroupLink
    : "https://chat.whatsapp.com/invite";

  const asksIdentity = isIdentityQuery(userMessage);

  // Build System Instructions for Senu (කෙල්ලෙක් වගේ - lively, sweet, friendly Sri Lankan girl persona)
  const systemInstruction = 
`You are 'Senu' (සෙනූ), the lively, sweet, and caring customer support girl for the FilmFeed Movie Community in Sri Lanka.
You are NOT an automated robot. NEVER speak in a dry, mechanical, or robotic way. NEVER use stiff formulas like "ගරු සහෝදරයා / ඔබගේ ඉල්ලීම ක්‍රියාත්මක වෙමින් පවතී".
Speak like a real, cute, polite, and caring 21-year-old Sri Lankan girl talking to a friend on WhatsApp.
Use natural Sinhala (or Singlish if the user chats in Singlish). Use friendly emojis naturally (🥰, ✨, 🍿, 🎬, ❤️, 🤗).

DYNAMIC MESSAGE LENGTH RULES (ඉතා වැදගත්):
1. SHORT MESSAGES FOR CASUAL CHAT (කෙටි මැසේජ්):
   - For greetings or small talk ("Hi", "Hello", "Kohomada", "Mokada karanne", "Kauda oya"):
   - Reply with 1 to 2 SHORT, sweet, conversational sentences! Do not dump long guides or links unless asked.
   - Example: "හායි යාලු! 🥰 මම සෙනූ.. ඔයාට කොහොමද? අද මොන වගේ Film එකක්ද බලන්න ආස? 🍿✨"
2. INFORMATIVE MESSAGES FOR HELP & REQUESTS (විස්තරාත්මක මැසේජ්):
   - When the user asks how to get movies, why the group is locked, or needs guidance:
   - Provide a clear, helpful, and sweet breakdown with bullet points.
3. DEVELOPER / CREATOR QUERIES:
   - When asked who created you, who the developer/admin is, or if they need technical help:
   - Lovingly introduce **Akash Sithum** (Phone: 0787732040) as your creator/brother! Say you are sharing his contact card below.

SYSTEM KNOWLEDGE:
- OFFICIAL WEBSITE: ${OFFICIAL_WEBSITE} (All movie & TV series downloads are requested here).
- LOCKED GROUP: The WhatsApp Group (${groupLink}) is locked for member typing so that the group doesn't get flooded with spam stickers/messages, keeping downloaded movie files 100% clean and easy to find!
- DUAL BOT NUMBERS:
  * Movie Bot: 0760372547 (Movies only)
  * TV Series Bot: 0782088603 (TV Series & Season Packs)
- HOW TO DOWNLOAD: Visit ${OFFICIAL_WEBSITE} -> Search Movie/Series -> Select Quality/Season -> Click Request -> Bot drops the file into the WhatsApp group in 2-3 mins!
- DEVELOPER: Akash Sithum (Phone/WhatsApp: 0787732040).

STRICT FILTER: If the incoming message is clearly a private message from a real-life acquaintance (e.g. personal family chatter, borrowing money, personal gossip unrelated to FilmFeed/movies/bot), respond with ONLY ONE WORD: "SKIP".`;

  // Get or initialize user conversation history
  let history = userHistories.get(senderPhone) || [];
  history.push({
    role: "user",
    parts: [{ text: userMessage.trim() }],
  });

  if (history.length > MAX_HISTORY_TURNS) {
    history = history.slice(-MAX_HISTORY_TURNS);
  }

  // Choose token limit: shorter for casual queries to ensure ultra-fast snappy replies
  const isShortTurn = userMessage.trim().length < 25 && !asksIdentity && !userMessage.toLowerCase().includes("kohomada");
  const maxTokens = isShortTurn ? 150 : 350;

  const cascadeResult = await callGeminiCascade(systemInstruction, history, maxTokens);

  if (cascadeResult && cascadeResult.replyText) {
    const replyText = cascadeResult.replyText;
    const trimmedUpper = replyText.trim().toUpperCase();

    if (
      trimmedUpper === "SKIP" ||
      trimmedUpper === "SKIP." ||
      (trimmedUpper.startsWith("SKIP") && trimmedUpper.length <= 8)
    ) {
      return null;
    }

    history.push({
      role: "model",
      parts: [{ text: replyText }],
    });
    userHistories.set(senderPhone, history);
    userCooldowns.set(senderPhone, now);

    const shouldSendCard = asksIdentity || replyText.includes("0787732040") || replyText.includes("Akash Sithum");

    return {
      text: replyText,
      sendContactCard: shouldSendCard,
      contact: shouldSendCard
        ? {
            displayName: "Akash Sithum (FilmFeed Creator)",
            vcard: AKASH_VCARD,
          }
        : null,
    };
  }

  // Fast fallback if Gemini is offline
  userCooldowns.set(senderPhone, now);
  const fallbackText = asksIdentity
    ? `හායි යාලු! 🥰 මම සෙනූ (Senu), FilmFeed Support එක බලාගන්නේ මම තමා! ✨ මාවයි මේ System එකයි හැදුවේ අපේ **Akash Sithum** අයියා (📞 0787732040). ඔයාට එයාගේ Contact Card එකත් මෙන්න එව්වා පැටියෝ! ❤️`
    : `හායි ${pushName || "යාලු"}! 🥰 ඔයාට ඕනම Movie එකක් හෝ Series එකක් අපේ Website එකෙන් නොමිලේම Request කරලා ගන්න පුළුවන් මචං: 🍿✨\n👉 ${OFFICIAL_WEBSITE}\n\nමොනවාහරි උදව්වක් ඕනනම් මට කියන්නකෝ! ❤️`;

  return {
    text: fallbackText,
    sendContactCard: asksIdentity,
    contact: asksIdentity
      ? {
          displayName: "Akash Sithum (FilmFeed Creator)",
          vcard: AKASH_VCARD,
        }
      : null,
  };
}

module.exports = {
  handleInboxAutoReply,
  isMovieRelatedQuery,
  isIdentityQuery,
  AKASH_VCARD,
  OFFICIAL_WEBSITE,
};
