const axios = require("axios");
const https = require("https");

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  Buffer.from("QVEuQWI4Uk42Sl9ZQ3Z2QlFaVnZ2dlBsVTNXVnNvWGJWQUVtZnhjcU9xR1V1UllTR0VBb1E=", "base64").toString("utf-8");

// Use IPv4 first agent to ensure ultra-fast DNS resolution
const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
});

// Cooldown tracker: phone -> timestamp
const userCooldowns = new Map();
// Conversation history: phone -> array of { role, parts }
const userHistories = new Map();

const COOLDOWN_MS = 10 * 1000; // 10 seconds cooldown per user
const MAX_HISTORY_TURNS = 4; // Keep up to 4 turns (2 user, 2 assistant)

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
    /\b(oya|oyaa)\s+(kawu?da|kavuda|kauda)\b/i,
    /\b(oya|oyaa)\s+(bot\s*kenekda|botda|mokakda)\b/i,
    /\b(mona|monawada)\s+bot\b/i,
    /\b(who\s*are\s*you|are\s*you\s*(a\s*)?bot|what\s*bot)\b/i,
    /\b(haduwe\s*kawuda|hadapu\s*kena|owner|creator|developer|akash|admin\s*kauda|admin\s*number)\b/i,
    /ඔයා\s*(කවුද|බොට්|මොන)/,
    /(හැදුවේ|නිර්මාණය|අයිතිකරු|ඇඩ්මින්)/,
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
    "movie", "film", "flim", "cinesub", "sinhalasub", "baiscope", "sub", "subtitle",
    "download", "downlod", "ganna", "ganne", "kohomada", "link", "group", "bot",
    "one", "ona", "oni", "denna", "ewanna", "evanna", "balanna", "balapu", "req", "request",
    "series", "season", "episode", "ep", "tamil", "hindi", "english", "korean", "anime",
    "hd", "4k", "720p", "1080p", "help", "hi", "hello", "hey", "ai", "oyaa", "oya",
    "filmfeed", "nexus", "admin", "puluwanda", "danna", "mokakda", "mokada", "ko", "koo",
    "done", "verify", "join", "pack", "password", "settings", "site", "web", "website"
  ];

  const hasKeyword = keywords.some((k) => lower.includes(k));
  // Sinhala unicode block check (U+0D80 to U+0DFF)
  const hasSinhala = /[\u0D80-\u0DFF]/.test(text);

  return hasKeyword || hasSinhala;
}

/**
 * Handle incoming direct inbox message and generate smart friendly Sinhala reply
 * Returns { text: string, sendContactCard: boolean } or null if personal conversation
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

  // If user asks directly who are you / creator, provide immediate fast dedicated response
  if (asksIdentity) {
    userCooldowns.set(senderPhone, now);
    const introText = 
`👋 *ආයුබෝවන් ${pushName}! මම FilmFeed WhatsApp Bot!* 🎬
━━━━━━━━━━━━━━━━━━━━
මම ලංකාවේ චිත්‍රපට හා TV Series රසිකයන් වෙනුවෙන්ම නිර්මාණය කර ඇති ස්වයංක්‍රීය AI Movie Downloader සේවාවයි. 🍿

⚡ *මගේ ප්‍රධාන කාර්යය:*
ඔබ අපගේ වෙබ් අඩවියෙන් Request කරන ඕනෑම චිත්‍රපටයක් Sinhala Subtitles සහිතව 1080p & 720p Full HD ගුණාත්මකභාවයෙන් කෙලින්ම අපගේ WhatsApp Group එකට Upload කර දීමයි!

👑 *මාව නිර්මාණය කළ නිර්මාණකරු (Creator / Developer):*
👤 *Akash Sithum*
📞 *Phone / WhatsApp:* +94 78 773 2040

💡 _ඔබට කිසියම් ගැටලුවක් ඇත්නම් මගේ Developer වන Akash Sithum මහතාව පහත Contact Card එකෙන් සම්බන්ධ කරගත හැක!_
━━━━━━━━━━━━━━━━━━━━
🌐 *Web Portal (Request Movies):* https://nexus-one-orpin.vercel.app
👥 *Official Group:* ${groupLink}
📢 *VIP Channel:* https://whatsapp.com/channel/0029Vb9AG1c3GJOsPvzqdu0R`;

    return {
      text: introText,
      sendContactCard: true,
      contact: {
        displayName: "Akash Sithum (FilmFeed Creator)",
        vcard: AKASH_VCARD,
      },
    };
  }

  // Build System Instructions for Gemini
  const systemInstruction = 
`You are 'FilmFeed Assistant' (චිත්‍රපට සහායක), the official customer care AI for FilmFeed Bot & Movie Network in Sri Lanka.
Users who message you in WhatsApp private chat are group members asking how to get/download movies, asking for specific films, or asking questions about the bot.

CRITICAL OPERATING RULES:
1. STRICT FILTER: If the user's message is purely a personal message with a real-life friend or family member (e.g. asking about family, money, casual personal life completely unrelated to movies or FilmFeed), reply with EXACTLY one word: "SKIP".
2. BOT IDENTITY & DEVELOPER:
   - Your name is FilmFeed WhatsApp Bot.
   - Your developer and owner is Akash Sithum (Phone: 0787732040 / +94 78 773 2040).
   - If they ask who you are or who created you, proudly and warmly mention Akash Sithum.
3. ABSOLUTE TRUTH ABOUT REQUESTING MOVIES:
   - Users CANNOT send messages inside the WhatsApp group (group chat is locked/announcements only).
   - The ONLY WAY to request movies or TV series is through our Official Website:
     🌐 Website: https://nexus-one-orpin.vercel.app
   - There is NO other way to request movies. Do NOT tell them to type commands in the group!
4. HOW TO EXPLAIN THE PROCESS TO USERS (In warm, polite, crystal-clear Sinhala):
   - Greet them politely (e.g., "ආයුබෝවන් යාලුවා! 🎬").
   - Explain that group chat messages are locked for members.
   - Explain the 3 simple steps to get any movie:
     1️⃣ අපගේ නිල වෙබ් අඩවියට පිවිසෙන්න: https://nexus-one-orpin.vercel.app
     2️⃣ ඔබට අවශ්‍ය චිත්‍රපටය Search කර 1-Click එකෙන් "Request" කරන්න.
     3️⃣ ඉල්ලීම ලැබුණු සැණින් FilmFeed Bot මඟින් චිත්‍රපටය Full HD / 720p Sinhala Subtitles සහිතව කෙලින්ම අපගේ WhatsApp Group එකට Upload කරනු ඇත!
5. If the user mentioned a specific movie title (e.g. Avatar, Leo, Inception, Scooby-Doo):
   Enthusiastically mention that movie! (e.g. "ඔබ ඉල්ලූ [Movie Name] චිත්‍රපටය අපගේ වෙබ් අඩවියෙන් Search කර දැන්ම Request කරන්න පුළුවන්!").
6. ALWAYS give the official links at the end:
   🌐 *Web Portal (Request Movies):* https://nexus-one-orpin.vercel.app
   👥 *Official Group (Movie Uploads):* ${groupLink}
   📢 *VIP Channel:* https://whatsapp.com/channel/0029Vb9AG1c3GJOsPvzqdu0R
7. Tone: Warm, highly respectful, friendly, helpful Sinhala with emojis. Around 4-7 lines.`;

  // Get or initialize user conversation history
  let history = userHistories.get(senderPhone) || [];
  history.push({
    role: "user",
    parts: [{ text: userMessage.trim() }],
  });

  if (history.length > MAX_HISTORY_TURNS) {
    history = history.slice(-MAX_HISTORY_TURNS);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const payload = {
      system_instruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: history,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 600,
      },
    };

    const res = await axios.post(url, payload, {
      httpsAgent,
      timeout: 12000,
      headers: { "Content-Type": "application/json" },
    });

    const replyText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    if (!replyText || replyText.toUpperCase() === "SKIP" || replyText.includes("SKIP")) {
      return null;
    }

    history.push({
      role: "model",
      parts: [{ text: replyText }],
    });
    userHistories.set(senderPhone, history);
    userCooldowns.set(senderPhone, now);

    const shouldSendCard = isIdentityQuery(replyText) || isIdentityQuery(userMessage);

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
  } catch (err) {
    console.warn(`[Gemini Assistant] API call notice: ${err.message}`);

    userCooldowns.set(senderPhone, now);
    const fallbackText = `👋 ආයුබෝවන් *${pushName}*! 🎬
FilmFeed Bot සේවාව වෙත ඔබව සාදරයෙන් පිළිගන්නවා!

📌 *චිත්‍රපට හා TV Series ලබාගන්නේ මෙහෙමයි:*
ගෲප් එක ඇතුලේ සාමාජිකයන්ට මැසේජ් දැමීමට නොහැකි බැවින්, චිත්‍රපට Request කළ හැකි **එකම ක්‍රමය අපගේ නිල වෙබ් අඩවිය පමණි!**

1️⃣ අපගේ Web Portal එකට පිවිසෙන්න:
👉 https://nexus-one-orpin.vercel.app

2️⃣ ඔබට අවශ්‍ය චිත්‍රපටය Search කර *Request* බටන් එක ඔබන්න.
3️⃣ ඉල්ලූ සැණින් බොට් මඟින් චිත්‍රපටය සිංහල උපසිරැසි සමඟින් කෙලින්ම අපගේ WhatsApp Group එකට Upload කරනු ඇත! 🍿

🌐 *Web Portal (Request):* https://nexus-one-orpin.vercel.app
👥 *Official Group:* ${groupLink}
📢 *VIP Channel:* https://whatsapp.com/channel/0029Vb9AG1c3GJOsPvzqdu0R`;

    return {
      text: fallbackText,
      sendContactCard: false,
      contact: null,
    };
  }
}

module.exports = {
  handleInboxAutoReply,
  isMovieRelatedQuery,
  isIdentityQuery,
  AKASH_VCARD,
};
