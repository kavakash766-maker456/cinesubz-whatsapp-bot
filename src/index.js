require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const axios = require("axios");

const PORT = process.env.PORT || 7860;
const BOT_PHONE = process.env.BOT_PHONE || "94760372547";
const TARGET_GROUP_JID = process.env.TARGET_GROUP_JID || "120363419930344447@g.us";
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "../auth_info");
const TEMP_DIR = path.join(__dirname, "../temp");
const STATS_FILE = path.join(AUTH_DIR, "user_stats.json");
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || process.env.KOYEB_APP_URL || null;

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2.0 GB WhatsApp Document Limit

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

let latestQR = null;
let isConnected = false;

// --------------------------------------------------------------------------
// User Request Stats Tracker
// --------------------------------------------------------------------------
function getUserStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch (e) {
    logger.error({ e }, "Error reading stats file");
  }
  return {};
}

function incrementUserRequest(userId, userName) {
  const stats = getUserStats();
  if (!stats[userId]) {
    stats[userId] = { count: 0, name: userName, firstSeen: new Date().toISOString() };
  }
  stats[userId].count += 1;
  stats[userId].name = userName || stats[userId].name;
  stats[userId].lastSeen = new Date().toISOString();

  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8");
  } catch (e) {
    logger.error({ e }, "Error saving stats file");
  }

  const count = stats[userId].count;
  let badge = "🌟 New Member";
  if (count >= 20) badge = "👑 Film Legend (VIP)";
  else if (count >= 10) badge = "🥇 Elite Cinephile";
  else if (count >= 5) badge = "🥈 Pro Movie Buff";
  else if (count >= 2) badge = "🥉 Regular Member";
  else badge = "✨ First Request (Welcome!)";

  return { count, badge };
}

// --------------------------------------------------------------------------
// 1. HTTP Server for Health Checks & Web QR Display
// --------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/ping" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "alive", connected: isConnected, uptime: process.uptime() }));
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (isConnected) {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>FilmFeed Bot Status</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="background:#0a0c14;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#121624;padding:30px;border-radius:20px;border:1px solid #25D366;text-align:center;">
          <h1 style="color:#25D366;margin:0 0 10px 0;">✅ FilmFeed Bot is Connected & Online!</h1>
          <p style="color:#aaa;">Bot Number: <b>${BOT_PHONE}</b></p>
          <p style="color:#aaa;">Target Group: <b>${TARGET_GROUP_JID}</b></p>
          <div style="margin-top:20px;padding:10px 20px;background:#25D366;color:#000;border-radius:10px;font-weight:bold;">Status: 24/7 Active with 2GB Safety Check</div>
        </div>
      </body>
      </html>
    `);
  } else if (latestQR) {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Scan QR - FilmFeed Bot</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="background:#0a0c14;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;">
        <div style="background:#121624;padding:30px;border-radius:20px;border:1px solid rgba(255,255,255,0.1);text-align:center;max-width:450px;">
          <h2 style="color:#25D366;margin:0 0 10px 0;">📲 Scan QR Code to Link WhatsApp</h2>
          <p style="color:#bbb;font-size:14px;">Open WhatsApp on <b>${BOT_PHONE}</b> &gt; Linked Devices &gt; Link a Device and scan the QR code below:</p>
          <div style="margin:20px 0;background:#fff;padding:15px;border-radius:12px;display:inline-block;">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(latestQR)}" alt="WhatsApp QR Code" style="display:block;" />
          </div>
          <p style="color:#888;font-size:12px;">Auto-refreshing every 20 seconds.</p>
        </div>
        <script>setTimeout(() => location.reload(), 20000);</script>
      </body>
      </html>
    `);
  } else {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>FilmFeed Bot</title><meta http-equiv="refresh" content="5"></head>
      <body style="background:#0a0c14;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <p style="color:#aaa;">⏳ Initializing WhatsApp Engine, please wait...</p>
      </body>
      </html>
    `);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  logger.info(`Health check & QR server listening on http://0.0.0.0:${PORT}`);
});

// --------------------------------------------------------------------------
// 2. Keep-Alive Self Ping
// --------------------------------------------------------------------------
function setupKeepAlivePing() {
  const pingIntervalMs = 8 * 60 * 1000;
  setInterval(async () => {
    try {
      if (SELF_URL) {
        const pingTarget = SELF_URL.startsWith("http") ? `${SELF_URL}/ping` : `https://${SELF_URL}/ping`;
        await axios.get(pingTarget, { timeout: 15000 });
        logger.info(`💓 [Keep-Alive Ping] Pinged: ${pingTarget}`);
      } else {
        await axios.get(`http://127.0.0.1:${PORT}/ping`, { timeout: 5000 });
      }
    } catch (e) {
      logger.warn(`⚠️ [Keep-Alive Ping] ${e.message}`);
    }
  }, pingIntervalMs);
}
setupKeepAlivePing();

// --------------------------------------------------------------------------
// 3. Movie Resolver
// --------------------------------------------------------------------------
async function resolveMovie(movieUrl, quality) {
  return new Promise((resolve, reject) => {
    const resolverScript = path.join(__dirname, "../resolver.py");
    const args = [movieUrl];
    if (quality) {
      args.push("--quality", quality);
    }

    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Resolver script error");
        return reject(err);
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse resolver JSON");
        reject(parseErr);
      }
    });
  });
}

// --------------------------------------------------------------------------
// 4. Inspect File Size via Ranged Request before Downloading
// --------------------------------------------------------------------------
async function checkFileSize(url) {
  try {
    const res = await axios({
      url,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Range: "bytes=0-1024",
      },
      timeout: 20000,
    });

    const contentRange = res.headers["content-range"];
    if (contentRange && contentRange.includes("/")) {
      const total = parseInt(contentRange.split("/")[1], 10);
      if (!isNaN(total)) return total;
    }

    const clen = res.headers["content-length"];
    if (clen && !isNaN(parseInt(clen, 10))) {
      return parseInt(clen, 10);
    }
  } catch (e) {
    logger.warn(`Unable to verify Content-Range: ${e.message}`);
  }
  return null;
}

// --------------------------------------------------------------------------
// 5. File Downloader
// --------------------------------------------------------------------------
async function downloadFile(url, destPath, onProgress) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    timeout: 300000,
  });

  const totalLength = parseInt(response.headers["content-length"] || "0", 10);
  let downloaded = 0;

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (totalLength > 0 && onProgress) {
      onProgress(downloaded, totalLength);
    }
  });

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on("finish", () => resolve(destPath));
    writer.on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// --------------------------------------------------------------------------
// 6. WhatsApp Bot Engine
// --------------------------------------------------------------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  logger.info(`Starting WhatsApp Bot v${version.join(".")} (Latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    browser: ["FilmFeed Downloader", "Chrome", "1.0.0"],
    keepAliveIntervalMs: 25000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      isConnected = false;
      console.log("\n==================================================");
      console.log("📲 SCAN THE QR CODE BELOW WITH WHATSAPP (0760372547):");
      console.log("==================================================");
      qrcode.generate(qr, { small: true });
      console.log("\n👉 Web QR Link: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr) + "\n");
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      logger.warn(
        `Connection closed due to ${lastDisconnect?.error}. Reconnecting: ${shouldReconnect}`
      );
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      }
    } else if (connection === "open") {
      latestQR = null;
      isConnected = true;
      logger.info(`✅ FilmFeed Bot Connected successfully! Active on: ${BOT_PHONE}`);
      logger.info(`🎯 Target Group: ${TARGET_GROUP_JID}`);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      const senderPhone = (msg.key.participant || remoteJid || "").split("@")[0];
      const pushName = msg.pushName || senderPhone || "Movie Fan";

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      if (!text || !text.includes("!req")) continue;

      logger.info(`Received command: ${text} from ${pushName} (${remoteJid})`);

      // Command pattern: !req <url> | <quality> | <token>
      const match = text.match(/!req(?:uest)?\s+([^\s|]+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);
      if (!match) continue;

      const movieUrl = match[1].trim();
      const quality = match[2] ? match[2].trim() : "1080p";
      const token = match[3] ? match[3].trim() : "";

      logger.info(`Processing: URL=${movieUrl}, Quality=${quality}, Requester=${pushName}`);

      const replyTarget = remoteJid;

      try {
        // Track User Request Statistics
        const { count, badge } = incrementUserRequest(senderPhone, pushName);

        await sock.sendMessage(replyTarget, {
          text: `⏳ *[FilmFeed Auto-Bot]*\n\nආයුබෝවන් *${pushName}*!\nඔබගේ *${count}* වන චිත්‍රපට ඉල්ලීම ලැබුණා (${badge}).\nDirect High-Speed ලින්ක් එක සකසමින් පවතී...\n\n📺 Quality: *${quality}*\n🔑 Token: *${token}*`,
        });

        // Resolve Direct Link & Movie Info
        const movieData = await resolveMovie(movieUrl, quality);

        if (!movieData.success || !movieData.direct_url) {
          await sock.sendMessage(replyTarget, {
            text: `❌ *[FilmFeed Auto-Bot]* Error: ${movieData.error || "චිත්‍රපට ලින්ක් එක ලබා ගැනීමට නොහැකි විය."}`,
          });
          continue;
        }

        const title = movieData.title || "Movie";
        const posterUrl = movieData.poster || movieData.backdrop;
        const directUrl = movieData.direct_url;
        const resolvedQuality = movieData.quality || quality;

        // ------------------------------------------------------------------
        // 2GB Size Check BEFORE downloading
        // ------------------------------------------------------------------
        logger.info(`Checking file size for ${title}...`);
        const verifiedSize = await checkFileSize(directUrl);
        const actualBytes = verifiedSize || (movieData.size_text && movieData.size_text.includes("GB") ? parseFloat(movieData.size_text) * 1024 * 1024 * 1024 : 0);

        if (actualBytes > MAX_FILE_SIZE_BYTES) {
          const sizeInGB = (actualBytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
          logger.warn(`Movie ${title} size (${sizeInGB}) exceeds 2GB limit! Skipping download.`);

          const sizeAlertMsg = 
`⚠️ *[FilmFeed Auto-Bot] ගොනු විශාලත්ව සීමාව (2GB Limit)*

ආයුබෝවන් *${pushName}*,
ඔබ ඉල්ලූ *${title}* (${resolvedQuality}) චිත්‍රපටයේ ගොනු ප්‍රමාණය: *${sizeInGB}* කි.

📌 *WhatsApp නීති රීති අනුව:*
WhatsApp මඟින් Document එකක් ලෙස එකවර යැවිය හැක්කේ උපරිම *2.00 GB* දක්වා ගොනු පමණි.

💡 *විසඳුම:*
කරුණාකර පහත වෙබ් අඩවියට ගොස් *720p* හෝ *480p* Quality එක (2GB ට අඩු) තෝරා නැවත Request කරන්න:
👉 https://web-umber-six-e1un7z6257.vercel.app`;

          await sock.sendMessage(replyTarget, { text: sizeAlertMsg });
          continue;
        }

        // ------------------------------------------------------------------
        // Advanced Poster Caption with WhatsApp @Mention Tag
        // ------------------------------------------------------------------
        const requesterJid = msg.key.participant || (remoteJid.endsWith("@s.whatsapp.net") ? remoteJid : null);
        const mentionTag = requesterJid ? `@${requesterJid.split("@")[0]}` : pushName;
        const mentionsList = requesterJid ? [requesterJid] : [];

        const caption = 
`🎬 *${title}*
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${mentionTag} (${pushName})
🎯 *User Stats:* ඔබගේ ${count} වන චිත්‍රපට ඉල්ලීම [${badge}]
🌟 *Quality:* ${resolvedQuality} ${movieData.size_text ? `(${movieData.size_text})` : ""}
🔑 *Token:* ${token || "DIRECT"}
⚡ *Subtitle:* Sinhala Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📝 *Storyline / සාරාංශය:*
${movieData.description ? movieData.description.substring(0, 420) + "..." : "FilmFeed Direct Release"}

📥 _චිත්‍රපටය බාගත වෙමින් පවතී... ස්වල්ප වේලාවකින් Document එකක් ලෙස Group එකට Upload වනු ඇත!_`;

        // Send Poster with Mention to Group
        if (posterUrl) {
          await sock.sendMessage(TARGET_GROUP_JID, {
            image: { url: posterUrl },
            caption: caption,
            mentions: mentionsList,
          });
        } else {
          await sock.sendMessage(TARGET_GROUP_JID, {
            text: caption,
            mentions: mentionsList,
          });
        }

        // Download Movie
        const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_") + `_${resolvedQuality}.mp4`;
        const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);

        logger.info(`Downloading video from ${directUrl} to ${tempFilePath}`);

        await downloadFile(directUrl, tempFilePath, (downloaded, total) => {
          const percent = Math.round((downloaded / total) * 100);
          if (percent % 25 === 0) {
            logger.info(`Download progress: ${percent}% (${Math.round(downloaded / 1024 / 1024)}MB)`);
          }
        });

        logger.info(`Download complete. Uploading document to WhatsApp group ${TARGET_GROUP_JID}...`);

        // Upload Movie Document with Mention to WhatsApp Group
        await sock.sendMessage(TARGET_GROUP_JID, {
          document: fs.readFileSync(tempFilePath),
          mimetype: "video/mp4",
          fileName: `${title} [${resolvedQuality}] [FilmFeed].mp4`,
          caption: `✅ *${title}* (${resolvedQuality})\n👤 Requested By: ${mentionTag} (${count}th movie)\n✨ Uploaded by FilmFeed Auto-Bot`,
          mentions: mentionsList,
        });

        // Instant Disk Cleanup
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          logger.info(`🗑️ Temporary file deleted from disk: ${tempFilePath}`);
        }

        // User Confirmation
        await sock.sendMessage(replyTarget, {
          text: `🎉 *[FilmFeed Auto-Bot]* සාර්ථකයි!\n*${pushName}*, ඔබ ඉල්ලූ *${title}* (${resolvedQuality}) චිත්‍රපටය WhatsApp සමූහය වෙත යවන ලදී. 🍿 Enjoy!`,
        });

      } catch (err) {
        logger.error({ err }, "Error handling movie request");
        await sock.sendMessage(replyTarget, {
          text: `⚠️ *[FilmFeed Auto-Bot]* දෝෂයක් සිදු විය: ${err.message}`,
        });
      }
    }
  });
}

startBot().catch((err) => logger.error({ err }, "Bot startup failed"));
