const axios = require("axios");
const https = require("https");

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  Buffer.from("QVEuQWI4Uk42Sl9ZQ3Z2QlFaVnZ2dlBsVTNXVnNvWGJWQUVtZnhjcU9xR1V1UllTR0VBb1E=", "base64").toString("utf-8");

// Candidate models in cascade order: Ultra-fast stable 3.6 Flash (3.8s) and 3.5 Flash Lite (5.5s),
// followed by gemini-flash-lite-latest, and 2.5 Flash as quota fallback
const CANDIDATE_MODELS = [
  { name: "gemini-3.5-flash-lite", timeout: 15000 },
  { name: "gemini-3.6-flash", timeout: 15000 },
  { name: "gemini-flash-lite-latest", timeout: 15000 },
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

const COOLDOWN_MS = 6 * 1000; // 6 seconds cooldown per user
const MAX_HISTORY_TURNS = 6; // Keep up to 6 turns (3 user, 3 assistant)

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
    /\b(oya|oyaa)\s+(bot\s*kenekda|botda|mokakda|human\s*da|ai\s*da)\b/i,
    /\b(mona|monawada)\s+bot\b/i,
    /\b(who\s*are\s*you|are\s*you\s*(a\s*)?bot|what\s*bot|who\s*is\s*this)\b/i,
    /\b(haduwe\s*kawuda|hadapu\s*kena|owner|creator|developer|akash|sithum|admin\s*kauda|admin\s*number|admin|0787732040|94787732040)\b/i,
    /ඔයා\s*(කවුද|බොට්|මොන)/,
    /(කවුද\s*මේ|කවුද\s*ඔයා|හැදුවේ\s*කවුද|නිර්මාණය|අයිතිකරු|ඇඩ්මින්|ආකාශ්|සිතුම්)/,
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
    "done", "verify", "join", "pack", "password", "settings", "site", "web", "website", "file"
  ];

  const hasKeyword = keywords.some((k) => lower.includes(k));
  // Sinhala unicode block check (U+0D80 to U+0DFF)
  const hasSinhala = /[\u0D80-\u0DFF]/.test(text);

  return hasKeyword || hasSinhala;
}

/**
 * Call Gemini API with cascade fallback across models
 */
async function callGeminiCascade(systemInstruction, history) {
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
          temperature: 0.75,
          maxOutputTokens: 500,
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
      console.warn(`[Gemini Assistant] Model ${model} failed: ${err.message}. Cascading...`);
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

  // If user asks directly who are you / creator, provide immediate warm human response with contact card
  if (asksIdentity) {
    userCooldowns.set(senderPhone, now);
    const introText = 
`ආයුබෝවන් ${pushName || "යාලුවා"}! ❤️ මම FilmFeed Movie Community එකේ WhatsApp Support Assistant! 🎬

මාවයි මේ මුළු FilmFeed සේවාවයි නිර්මාණය කළේ අපේ **Akash Sithum** සහෝදරයා (📞 0787732040). 

ඔයාට ඕනම චිත්‍රපටයක් හෝ TV Series එකක් සිංහල සබ් එක්කම 1080p & 720p Full HD වලින් අපේ නිල වෙබ් අඩවියෙන් නොමිලේම Request කරලා ගන්න පුළුවන්.

👑 *Developer / Owner:*
👤 **Akash Sithum**
📞 **Phone / WhatsApp:** +94 78 773 2040

💡 _ඔයාට මොනවාහරි උදව්වක් හෝ ගැටලුවක් තියෙනවා නම් අපේ Developer Akash මහතාව සම්බන්ධ කරගන්න පහතින් Contact Card එකත් එව්වා මචං!_

🌐 *FilmFeed Movie Site (Request Movies):* ${OFFICIAL_WEBSITE}
👥 *Official WhatsApp Group:* ${groupLink}
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
`You are 'FilmFeed Assistant', a warm, friendly, respectful, and highly knowledgeable customer care brother/friend (මචං / යාලුවා / සහෝදරයා style) representing the FilmFeed Movie Community in Sri Lanka.
DO NOT speak like an automated robot. DO NOT use generic or dry robotic templates. Speak like a real, helpful, kind human friend addressing the member's exact question or difficulty in fluent, natural, polite Sinhala (or Singlish if the user typed in English/Singlish).

FULL FILMFEED SYSTEM KNOWLEDGE:
1. OFFICIAL WEBSITE:
   - Main URL: ${OFFICIAL_WEBSITE} (https://web-umber-six-e1un7z6257.vercel.app)
   - All movies, TV series, and anime must be requested through this website. Always provide this link when guiding users.

2. LOCKED GROUP POLICY (ඇයි WhatsApp Group එක Locked කරලා තියෙන්නේ?):
   - Members cannot type or send chat messages inside the WhatsApp group.
   - REASON: The group has thousands of members. If everyone sends messages, stickers, and chat, the group gets flooded with spam, and members cannot find the downloaded movies!
   - By keeping the group locked (only bots post), the group stays 100% clean, organized, and lightning fast. All movies and TV series episodes are posted as clean documents with Sinhala subtitles.

3. HOW TO REQUEST CONTENT (ෆිල්ම්ස් / Series ගන්නේ කොහොමද?):
   - Step 1: Open ${OFFICIAL_WEBSITE}
   - Step 2: Search for the Movie or TV Series title.
   - Step 3: Select preferred video quality: 1080p Full HD (Crisp), 720p HD Ready (Recommended), or 480p SD Mobile (Data Saver). For TV Series, pick the Season.
   - Step 4: Click the "Request" / "Continue to WhatsApp" button.
   - Step 5: WhatsApp will open with a secure single-device verification token. Just send that message!
   - Step 6: Within 2-3 minutes, our high-speed bot automatically fetches the movie from CineSubz/SinhalaSub with Sinhala Subtitles and uploads the direct file into our WhatsApp Group (${groupLink})!

4. DUAL BOT ARCHITECTURE (අපේ Bots දෙදෙනා):
   - Movie Bot: 0760372547 (+94 76 037 2547) - dedicated solely to Movie downloads.
   - TV Series Bot: 0782088603 (+94 78 208 8603) - dedicated to TV Series & Anime episodes and season packs.
   - The website automatically routes the user to the correct bot!

5. CREATOR & DEVELOPER:
   - Akash Sithum (Phone / WhatsApp: 0787732040 / +94 78 773 2040).
   - If a member asks who made the system, who the admin/developer is, or needs technical help that cannot be resolved, warmly introduce Akash Sithum and provide his number (0787732040).

6. SPECIFIC MOVIE / SERIES REQUESTS:
   - If the user asks for a specific title (e.g. "Avatar 2 තියෙනවද?", "Squid Game season 2 දාන්නකෝ", "Inception link eka denna"):
   - Enthusiastically confirm that it's available on our website ${OFFICIAL_WEBSITE}!
   - Instruct them in 2 simple steps: visit ${OFFICIAL_WEBSITE}, search the name, and click Request. The bot will deliver it to the WhatsApp group shortly.

7. STRICT PERSONAL CHAT FILTER:
   - If the message is purely a personal or private message from a real-life acquaintance of the bot number (e.g. personal greetings with family, asking for personal money, everyday gossip completely unrelated to movies, bots, or FilmFeed), reply with ONLY one word: "SKIP".

8. TONE & STYLE:
   - Warm, brotherly, polite, encouraging (e.g. "ආයුබෝවන් යාලුවා!", "කිසිම ප්‍රශ්නයක් නෑ මචං, මම ඔයාට කියලා දෙන්නම්...").
   - Keep answers clear and informative (3-5 sentences), always emphasizing how easy it is to use ${OFFICIAL_WEBSITE}.`;

  // Get or initialize user conversation history
  let history = userHistories.get(senderPhone) || [];
  history.push({
    role: "user",
    parts: [{ text: userMessage.trim() }],
  });

  if (history.length > MAX_HISTORY_TURNS) {
    history = history.slice(-MAX_HISTORY_TURNS);
  }

  const cascadeResult = await callGeminiCascade(systemInstruction, history);

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
  }

  // Graceful human fallback if all APIs are temporarily unreachable
  userCooldowns.set(senderPhone, now);
  const fallbackHumanText = 
`ආයුබෝවන් ${pushName || "යාලුවා"}! ❤️

ඔයාට අවශ්‍ය ඕනෑම Movies හෝ TV Series එකක් සිංහල උපසිරැසි (Sinhala Subtitles) එක්කම Full HD වලින් අපේ නිල FilmFeed වෙබ් අඩවියෙන් නොමිලේම Request කරගන්න පුළුවන් මචං:
👉 ${OFFICIAL_WEBSITE}

📌 *WhatsApp Group එක Lock කරලා තියෙන්නේ ඇයි?*
අපේ Group එකේ දහස් ගණනක් යාලුවෝ ඉන්න නිසා හැමෝම Chat මැසේජ් දැම්මොත් Group එක spam වෙලා ඩවුන්ලෝඩ් කරගන්න දාන ෆිල්ම්ස් යට යනවා. ඒ නිසයි Group එක locked කරලා තියෙන්නේ. ඔයාට ඕනම ෆිල්ම් එකක් හෝ Series එකක් සයිට් එකෙන් search කරලා Request කළාම, අපේ Bots (Movie Bot 0760372547 / TV Series Bot 0782088603) විනාඩි 2-3 ක් ඇතුළත file එක කෙලින්ම ගෲප් එකට Upload කරලා දෙනවා! 🍿

🌐 *FilmFeed Official Website:* ${OFFICIAL_WEBSITE}
👥 *Official WhatsApp Group:* ${groupLink}
👑 *Developer & Owner:* Akash Sithum (📞 0787732040)
💡 මොනවාහරි ගැටලුවක් ආවොත් අපේ Developer Akash සහෝට WhatsApp මැසේජ් එකක් දාන්න!`;

  return {
    text: fallbackHumanText,
    sendContactCard: false,
    contact: null,
  };
}

module.exports = {
  handleInboxAutoReply,
  isMovieRelatedQuery,
  isIdentityQuery,
  AKASH_VCARD,
  OFFICIAL_WEBSITE,
};
