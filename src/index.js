require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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
const TARGET_GROUP_JIDS = (process.env.TARGET_GROUP_JIDS || "120363419930344447@g.us,120363428509877949@g.us")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGET_GROUP_JID = TARGET_GROUP_JIDS[0];
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "../auth_info");
const TEMP_DIR = path.join(__dirname, "../temp");
const STATS_FILE = path.join(AUTH_DIR, "user_stats.json");
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || process.env.KOYEB_APP_URL || null;

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2.0 GB WhatsApp Document Limit

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught Exception in Bot Engine (recovered)");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled Rejection in Bot Engine (recovered)");
});

let latestQR = null;
let isConnected = false;
let waSocket = null;

// --------------------------------------------------------------------------
// Request Queue System (FIFO)
// --------------------------------------------------------------------------
const requestQueue = [];
let isProcessingQueue = false;
let currentProcessingItem = null;

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
    return res.end(
      JSON.stringify({
        status: "alive",
        connected: isConnected,
        queueLength: requestQueue.length,
        isProcessing: isProcessingQueue,
        uptime: process.uptime(),
      })
    );
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (isConnected) {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>FilmFeed Bot Status</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="background:#000000;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#111;padding:30px;border-radius:20px;border:1px solid #333;text-align:center;">
          <h1 style="color:#fff;margin:0 0 10px 0;">FILMFEED 4K BOT ONLINE</h1>
          <p style="color:#aaa;">Bot Number: <b>${BOT_PHONE}</b></p>
          <p style="color:#aaa;">Target Group: <b>${TARGET_GROUP_JID}</b></p>
          <p style="color:#aaa;">Queue Items: <b>${requestQueue.length}</b></p>
          <div style="margin-top:20px;padding:10px 20px;background:#fff;color:#000;border-radius:10px;font-weight:bold;">Status: TV Series Batch & Movie Engine Active</div>
        </div>
      </body>
      </html>
    `);
  } else if (latestQR) {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Scan QR - FilmFeed Bot</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="background:#000000;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;">
        <div style="background:#111;padding:30px;border-radius:20px;border:1px solid #333;text-align:center;max-width:450px;">
          <h2 style="color:#fff;margin:0 0 10px 0;">📲 Scan QR Code to Link WhatsApp</h2>
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
      <body style="background:#000000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
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
// 3. Movie & Series Resolver Helpers
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

async function resolveSeriesEpisodes(seriesUrl) {
  return new Promise((resolve, reject) => {
    const resolverScript = path.join(__dirname, "../resolver.py");
    const args = [seriesUrl, "--episodes"];

    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Series episodes resolver error");
        return reject(err);
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse series episodes JSON");
        reject(parseErr);
      }
    });
  });
}

// --------------------------------------------------------------------------
// 4. File Size Inspection via Ranged Request
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
// --------------------------------------------------------------------------
// 6. Queue Processing Loop (Handles Single Movie OR Full TV Series Season)
// --------------------------------------------------------------------------
async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0 || !waSocket) return;

  isProcessingQueue = true;
  const currentTask = requestQueue.shift();
  currentProcessingItem = currentTask;

  const {
    isSeriesSeason,
    seasonNumber,
    movieUrl,
    quality,
    token,
    replyTarget,
    requesterJid,
    pushName,
    mentionTag,
    mentionsList,
    userStats,
  } = currentTask;
  const { count, badge } = userStats;

  logger.info(
    `[Queue Engine] Processing task for ${pushName}: ${movieUrl} | Type=${isSeriesSeason ? `Series S${seasonNumber}` : "Movie"} | Remaining in queue: ${requestQueue.length}`
  );

  // Helper function to broadcast message to all active groups
  const broadcastToGroups = async (payload) => {
    for (const jid of TARGET_GROUP_JIDS) {
      try {
        await waSocket.sendMessage(jid, payload);
      } catch (err) {
        logger.error({ err, jid }, `Failed sending to group ${jid}`);
      }
    }
  };

  try {
    // ----------------------------------------------------------------------
    // MODE A: TV SERIES SEASON BATCH (Processes All Episodes Sequentially)
    // ----------------------------------------------------------------------
    if (isSeriesSeason) {
      await waSocket.sendMessage(replyTarget, {
        text: `🚀 *[FilmFeed TV Series Engine]*\n\n*${pushName}*, ඔබ ඉල්ලූ Season ${seasonNumber} පැක් එක සැකසීම ආරම්භ විය!\nසියලුම Episodes එකින් එක Download වී Group එකට Upload වනු ඇත.`,
        mentions: mentionsList,
      });

      const seriesData = await resolveSeriesEpisodes(movieUrl);
      let episodes = seriesData.episodes || [];

      // Filter by requested season if season number given
      if (seasonNumber) {
        const seasonEps = episodes.filter((ep) => ep.season === seasonNumber);
        if (seasonEps.length > 0) episodes = seasonEps;
      }

      if (episodes.length === 0) {
        // Fallback: try single resolve
        const singleData = await resolveMovie(movieUrl, quality);
        if (singleData.success) {
          episodes = [{ season: seasonNumber || 1, episode: 1, title: singleData.title, url: movieUrl }];
        }
      }

      if (episodes.length === 0) {
        await waSocket.sendMessage(replyTarget, {
          text: `❌ *[FilmFeed TV Series]* Season ${seasonNumber} සඳහා Episodes සොයාගත නොහැකි විය.`,
        });
        isProcessingQueue = false;
        currentProcessingItem = null;
        processQueue();
        return;
      }

      const showTitle = seriesData.title || "TV Series";
      const posterUrl = seriesData.poster || seriesData.backdrop;
      const totalEpisodes = episodes.length;

      // Send Season Overview Poster to WhatsApp Group
      const seasonCaption = 
`🎬 *${showTitle} (Season ${seasonNumber})*
━━━━━━━━━━━━━━━━━━━━
📦 *Pack Type:* Complete Season Batch
🔢 *Total Episodes:* ${totalEpisodes} Episodes
👤 *Requested By:* ${mentionTag} (${pushName})
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
🌟 *Quality:* ${quality}
🔑 *Token:* ${token || "VIP_SEASON"}
⚡ *Subtitle:* Sinhala Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📥 _Episode 1 සිට ${totalEpisodes} දක්වා පිළිවෙළින් බාගත වී Group එකට Upload වනු ඇත!_`;

      if (posterUrl) {
        await broadcastToGroups({
          image: { url: posterUrl },
          caption: seasonCaption,
          mentions: mentionsList,
        });
      } else {
        await broadcastToGroups({
          text: seasonCaption,
          mentions: mentionsList,
        });
      }

      // Download and Upload each episode 1 by 1
      let uploadedCount = 0;
      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        const epIndex = i + 1;
        logger.info(`Resolving and downloading episode ${epIndex}/${totalEpisodes}: ${ep.title} (${ep.url})`);

        try {
          const epData = await resolveMovie(ep.url, quality);
          if (!epData.success || !epData.direct_url) {
            logger.warn(`Skipping episode ${epIndex} (${ep.title}): ${epData.error || "No direct link"}`);
            continue;
          }

          const epTitle = epData.title || ep.title || `Episode ${epIndex}`;
          const directUrl = epData.direct_url;
          const resolvedQuality = epData.quality || quality;

          // Check 2GB Limit
          const verifiedSize = await checkFileSize(directUrl);
          if (verifiedSize && verifiedSize > MAX_FILE_SIZE_BYTES) {
            logger.warn(`Episode ${epTitle} exceeds 2GB limit! Skipping.`);
            continue;
          }

          const safeName = epTitle.replace(/[^a-zA-Z0-9_-]/g, "_") + `_${resolvedQuality}.mp4`;
          const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);

          await downloadFile(directUrl, tempFilePath);

          // Upload Episode Document to All Groups
          await broadcastToGroups({
            document: { url: tempFilePath },
            mimetype: "video/mp4",
            fileName: `${epTitle} [${resolvedQuality}] [FilmFeed].mp4`,
            caption: `✅ *${epTitle}* (${resolvedQuality})\n👤 Requested By: ${mentionTag}\n📦 Season ${seasonNumber} Pack [${epIndex}/${totalEpisodes} Episodes]\n✨ Uploaded by FilmFeed Auto-Bot`,
            mentions: mentionsList,
          });

          uploadedCount++;

          // Delete temp file immediately
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }

          // Small cooldown between episodes
          await new Promise((r) => setTimeout(r, 2000));
        } catch (epErr) {
          logger.error({ epErr }, `Error downloading episode ${epIndex}`);
        }
      }

      // Final Season Completion Notification
      await waSocket.sendMessage(replyTarget, {
        text: `🎉 *[FilmFeed TV Series]* සම්පූර්ණයි!\n*${pushName}*, ඔබ ඉල්ලූ *${showTitle}* (Season ${seasonNumber}) හි Episodes ${uploadedCount}/${totalEpisodes} සාර්ථකව WhatsApp Group එකට Upload කරන ලදී. 🍿 Enjoy!`,
        mentions: mentionsList,
      });

    } else {
      // ----------------------------------------------------------------------
      // MODE B: SINGLE MOVIE PROCESSING
      // ----------------------------------------------------------------------
      await waSocket.sendMessage(replyTarget, {
        text: `🚀 *[FilmFeed Auto-Bot]*\n\n*${pushName}*, ඔබගේ වාරය පැමිණියා! චිත්‍රපටය බාගත කිරීම දැන් ආරම්භ වේ...\n\n📺 Quality: *${quality}*\n🔑 Token: *${token}*`,
        mentions: mentionsList,
      });

      const movieData = await resolveMovie(movieUrl, quality);

      if (!movieData.success || !movieData.direct_url) {
        await waSocket.sendMessage(replyTarget, {
          text: `❌ *[FilmFeed Auto-Bot]* Error: ${movieData.error || "චිත්‍රපට ලින්ක් එක ලබා ගැනීමට නොහැකි විය."}`,
        });
        isProcessingQueue = false;
        currentProcessingItem = null;
        processQueue();
        return;
      }

      const title = movieData.title || "Movie";
      const posterUrl = movieData.poster || movieData.backdrop;
      const directUrl = movieData.direct_url;
      const resolvedQuality = movieData.quality || quality;

      // 2GB Size Check BEFORE download
      logger.info(`Checking file size for ${title}...`);
      const verifiedSize = await checkFileSize(directUrl);
      const actualBytes =
        verifiedSize ||
        (movieData.size_text && movieData.size_text.includes("GB")
          ? parseFloat(movieData.size_text) * 1024 * 1024 * 1024
          : 0);

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
කරුණාකර වෙබ් අඩවියෙන් *720p* හෝ *480p* Quality එක (2GB ට අඩු) තෝරා නැවත Request කරන්න:
👉 https://web-umber-six-e1un7z6257.vercel.app`;

        await waSocket.sendMessage(replyTarget, { text: sizeAlertMsg });
        isProcessingQueue = false;
        currentProcessingItem = null;
        processQueue();
        return;
      }

      // Poster Caption
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

      // 1. Send Poster to all groups
      if (posterUrl) {
        await broadcastToGroups({
          image: { url: posterUrl },
          caption: caption,
          mentions: mentionsList,
        });
      } else {
        await broadcastToGroups({
          text: caption,
          mentions: mentionsList,
        });
      }

      // 2. Download Movie File
      const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_") + `_${resolvedQuality}.mp4`;
      const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);

      logger.info(`Downloading video from ${directUrl} to ${tempFilePath}`);

      await downloadFile(directUrl, tempFilePath, (downloaded, total) => {
        const percent = Math.round((downloaded / total) * 100);
        if (percent % 25 === 0) {
          logger.info(`Download progress for ${title}: ${percent}% (${Math.round(downloaded / 1024 / 1024)}MB)`);
        }
      });

      logger.info(`Download complete. Uploading document to WhatsApp groups...`);

      // 3. Upload Document to all groups
      await broadcastToGroups({
        document: { url: tempFilePath },
        mimetype: "video/mp4",
        fileName: `${title} [${resolvedQuality}] [FilmFeed].mp4`,
        caption: 
`🎬 *${title}* (${resolvedQuality})
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${mentionTag}
🎯 *User Stats:* ${count} වන සාර්ථක නිකුතුව! [${badge}]
⚡ *Status:* Group Broadcast Completed
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed 4K Auto-Bot Engine
👉 Request: https://web-umber-six-e1un7z6257.vercel.app`,
        mentions: mentionsList,
      });

      // 4. Delete temp file
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // 5. Notify Requester
      await waSocket.sendMessage(replyTarget, {
        text: `🎉 *[FilmFeed Auto-Bot]* සාර්ථකයි!\n*${pushName}*, ඔබ ඉල්ලූ *${title}* (${resolvedQuality}) චිත්‍රපටය WhatsApp සමූහය වෙත යවන ලදී. 🍿 Enjoy!`,
        mentions: mentionsList,
      });
    }

  } catch (err) {
    logger.error({ err }, "Error processing queued task");
    await waSocket.sendMessage(replyTarget, {
      text: `⚠️ *[FilmFeed Auto-Bot]* දෝෂයක් සිදු විය: ${err.message}`,
    });
  } finally {
    isProcessingQueue = false;
    currentProcessingItem = null;
    setTimeout(processQueue, 1500);
  }
}

// --------------------------------------------------------------------------
// 7. WhatsApp Bot Initialization & Event Handler
// --------------------------------------------------------------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  logger.info(`Starting WhatsApp Bot v${version.join(".")} (Latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    browser: ["FilmFeed Downloader", "Chrome", "1.0.0"],
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    getMessage: async (key) => {
      return { conversation: "" };
    },
  });

  waSocket = sock;

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
      processQueue();
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      try {
        const remoteJid = msg.key.remoteJid || "";
        const senderPhone = (msg.key.participant || remoteJid || "").split("@")[0].replace(/:\d+/, "");
        const pushName = msg.pushName || senderPhone || "Movie Fan";

        const rawJid = msg.key.participant || (remoteJid.endsWith("@s.whatsapp.net") ? remoteJid : null);
        // Normalize to pure phone number (strips :device suffix such as :1 or :12)
        const cleanPhone = rawJid
          ? rawJid.replace(/:\d+/, "").split("@")[0]
          : senderPhone;
        const cleanJid = cleanPhone ? `${cleanPhone}@s.whatsapp.net` : null;

        const requesterJid = cleanJid;
        const mentionTag = cleanPhone ? `@${cleanPhone}` : pushName;
        const mentionsList = cleanJid ? [cleanJid] : [];

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          "";

        if (!text || (!text.includes("!req") && !text.includes("!season"))) continue;

        logger.info(`Received command: ${text} from ${pushName} (${remoteJid})`);

      // 1. Check for TV Series Season command:
      // !req_season <url> | S<num> | <quality> | <token> OR !req <url> | S1 | 720p | token
      const seasonMatch = text.match(/!(?:req_season|season)\s+([^\s|]+)(?:\s*\|\s*[Ss]?(\d+))?(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i) ||
                          text.match(/!req(?:uest)?\s+([^\s|]+)\s*\|\s*[Ss](\d+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);

      let isSeriesSeason = false;
      let seasonNumber = 1;
      let movieUrl = "";
      let quality = "720p";
      let token = "";

      if (seasonMatch) {
        isSeriesSeason = true;
        movieUrl = seasonMatch[1].trim();
        seasonNumber = seasonMatch[2] ? parseInt(seasonMatch[2].trim(), 10) : 1;
        quality = seasonMatch[3] ? seasonMatch[3].trim() : "720p";
        token = seasonMatch[4] ? seasonMatch[4].trim() : "";
      } else {
        // Standard Movie command: !req <url> | <quality> | <token>
        const match = text.match(/!req(?:uest)?\s+([^\s|]+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);
        if (!match) continue;

        movieUrl = match[1].trim();
        quality = match[2] ? match[2].trim() : "1080p";
        token = match[3] ? match[3].trim() : "";
        if (movieUrl.includes("/tvshows/")) {
          isSeriesSeason = true;
          seasonNumber = 1;
        }
      }

      const replyTarget = remoteJid;
      const userStats = incrementUserRequest(senderPhone, pushName);
      const { count, badge } = userStats;

      const isBusy = isProcessingQueue || requestQueue.length > 0;
      const queuePosition = requestQueue.length + (isProcessingQueue ? 1 : 0);

      const taskItem = {
        isSeriesSeason,
        seasonNumber,
        movieUrl,
        quality,
        token,
        replyTarget,
        requesterJid,
        pushName,
        mentionTag,
        mentionsList,
        userStats,
        createdAt: Date.now(),
      };

      if (isBusy) {
        requestQueue.push(taskItem);
        logger.info(`Task added to queue at #${queuePosition} for ${pushName}`);

        const queueMessage = 
`⏳ *[FilmFeed Auto-Bot] පෝලිමේ රඳවා ඇත (Queued)*

ආයුබෝවන් *${pushName}* (${mentionTag}),
දැනට වෙනත් ${isProcessingQueue && currentProcessingItem?.isSeriesSeason ? "TV Series Season එකක්" : "චිත්‍රපටයක්"} බාගත වෙමින් පවතී.

📊 *ඔබගේ පෝලිම් ස්ථානය (Queue Position):* *#${queuePosition}*
📦 *ඉල්ලීම:* ${isSeriesSeason ? `TV Series (Season ${seasonNumber})` : "Movie"}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
📺 *Quality:* ${quality}
🔑 *Token:* ${token}

_කලින් ඉල්ලීම් අවසන් වූ සැණින් ඔබගේ ඉල්ලීම බාගත කර Group එකට Upload වනු ඇත! ස්තූතියි!_`;

        await sock.sendMessage(replyTarget, {
          text: queueMessage,
          mentions: mentionsList,
        });

      } else {
        requestQueue.push(taskItem);

        const startMessage = 
`⏳ *[FilmFeed Auto-Bot] සකසමින් පවතී (Processing Now)*

ආයුබෝවන් *${pushName}* (${mentionTag})!
ඔබගේ *${count}* වන ඉල්ලීම ලැබුණා [${badge}].
${isSeriesSeason ? `📺 *TV Series (Season ${seasonNumber}) Complete Pack* සකස් කිරීම ආරම්භ විය...` : "🎬 Direct High-Speed ලින්ක් එක සකසා බාගත කිරීම ආරම්භ විය..."}

📺 *Quality:* ${quality}
🔑 *Token:* ${token}`;

        await sock.sendMessage(replyTarget, {
          text: startMessage,
          mentions: mentionsList,
        });

        processQueue();
      }
    } catch (msgErr) {
      logger.error({ msgErr }, "Error handling incoming WhatsApp message item");
    }
  }
});
}

startBot().catch((err) => logger.error({ err }, "Bot startup failed"));
