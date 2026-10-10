require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const axios = require("axios");
const CloudSession = require("./cloud_session");

const PORT = process.env.PORT || 7860;
const BOT_PHONE = process.env.BOT_PHONE || "94760372547";
const TARGET_GROUP_JIDS = (process.env.TARGET_GROUP_JIDS || "120363419930344447@g.us,120363428509877949@g.us")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGET_GROUP_JID = TARGET_GROUP_JIDS[0];
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "../auth_info");
const cloudSession = new CloudSession(AUTH_DIR, process.env.GH_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
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

function incrementUserRequest(userId, userName, movieTitle, quality) {
  const stats = getUserStats();
  if (!stats[userId]) {
    stats[userId] = { count: 0, name: userName, firstSeen: new Date().toISOString(), history: [] };
  }
  if (!stats[userId].history) {
    stats[userId].history = [];
  }
  stats[userId].count += 1;
  stats[userId].name = userName || stats[userId].name;
  stats[userId].lastSeen = new Date().toISOString();

  if (movieTitle) {
    stats[userId].history.push({
      title: movieTitle,
      quality: quality || "720p",
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
    if (stats[userId].history.length > 25) {
      stats[userId].history = stats[userId].history.slice(-25);
    }
  }

  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8");
  } catch (e) {
    logger.error({ e }, "Error saving stats file");
  }

  const count = stats[userId].count;
  const history = stats[userId].history || [];
  let badge = "🌟 New Member";
  if (count >= 20) badge = "👑 Film Legend (VIP)";
  else if (count >= 10) badge = "🥇 Elite Cinephile";
  else if (count >= 5) badge = "🥈 Pro Movie Buff";
  else if (count >= 2) badge = "🥉 Regular Member";
  else badge = "✨ First Request (Welcome!)";

  return { count, badge, history };
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

async function downloadGDriveFile(url, destPath, quality = null) {
  return new Promise((resolve, reject) => {
    const resolverScript = path.join(__dirname, "../resolver.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const args = [resolverScript, url, "--download-gdrive", destPath];
    if (quality) {
      args.push("--quality", quality);
    }

    logger.info(`Invoking Google Drive gdown engine for: ${url} (Quality: ${quality || "auto"})`);
    execFile(pythonCmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "gdown script execution error");
        return reject(err);
      }
      try {
        const data = JSON.parse(stdout);
        if (data.success && fs.existsSync(destPath) && fs.statSync(destPath).size > 1000000) {
          logger.info(`gdown download successful! Final size: ${Math.round(data.size / 1024 / 1024)}MB`);
          resolve(destPath);
        } else {
          reject(new Error(data.error || "Google Drive download produced 0MB or invalid file"));
        }
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse gdown response JSON");
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
  return new Promise((resolve, reject) => {
    const fastDownloader = path.join(__dirname, "../fast_downloader.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const { spawn } = require("child_process");

    const child = spawn(pythonCmd, [fastDownloader, url, destPath, "8"]);
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line.trim());
          if (data.type === "progress" && onProgress) {
            onProgress(data.downloaded, data.total, data.speed_mb);
          }
        } catch (_) {}
      }
    });

    child.stderr.on("data", (errData) => {
      logger.warn(`[FastDownloader] ${errData.toString().trim()}`);
    });

    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 1000000) {
        resolve(destPath);
      } else {
        logger.warn(`Fast parallel downloader exited with code ${code}. Falling back to standard stream...`);
        const writer = fs.createWriteStream(destPath);
        axios({
          url,
          method: "GET",
          responseType: "stream",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          timeout: 300000,
        })
          .then((response) => {
            const totalLength = parseInt(response.headers["content-length"] || "0", 10);
            let downloaded = 0;
            response.data.on("data", (c) => {
              downloaded += c.length;
              if (onProgress) onProgress(downloaded, totalLength, 0);
            });
            response.data.pipe(writer);
            writer.on("finish", () => resolve(destPath));
            writer.on("error", (err) => {
              fs.unlink(destPath, () => {});
              reject(err);
            });
          })
          .catch(reject);
      }
    });

    child.on("error", (err) => {
      logger.error({ err }, "Failed spawning fast_downloader.py");
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
    let sentCount = 0;
    let lastError = null;
    for (const jid of TARGET_GROUP_JIDS) {
      try {
        await waSocket.sendMessage(jid, payload);
        sentCount++;
      } catch (err) {
        lastError = err;
        logger.error({ err, jid }, `Failed sending to group ${jid}: ${err.message}`);
      }
    }
    if (sentCount === 0 && TARGET_GROUP_JIDS.length > 0) {
      throw lastError || new Error("WhatsApp message delivery failed to all target groups");
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
      const statusTrackerKeys = [];

      const initialQueueMsg = await waSocket.sendMessage(replyTarget, {
        text: `🚀 *[FilmFeed Auto-Bot]*\n\n*${pushName}*, ඔබගේ වාරය පැමිණියා! චිත්‍රපටය බාගත කිරීම දැන් ආරම්භ වේ...\n\n📺 Quality: *${quality}*\n🔑 Token: *${token}*`,
        mentions: mentionsList,
      });
      if (initialQueueMsg?.key) statusTrackerKeys.push(initialQueueMsg.key);

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

      // Live Real-Time Status Tracker Message for Requester
      let liveStatusMsg = null;
      try {
        liveStatusMsg = await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *චිත්‍රපටය:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
⏳ *තත්ත්වය:* බාගත කිරීම ආරම්භ විය...
📥 *Download Progress:* 0%
⚡ *Server:* High-Speed CDN
━━━━━━━━━━━━━━━━━━━━`,
          mentions: mentionsList,
        });
        if (liveStatusMsg?.key) statusTrackerKeys.push(liveStatusMsg.key);
      } catch (_) {}

      // 1. Download Movie File to Disk First
      const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_") + `_${resolvedQuality}.mp4`;
      const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);

      const isGDrive =
        movieData.is_cartoon ||
        movieData.is_anime ||
        movieData.is_gdrive ||
        movieUrl.includes("drive.google.com") ||
        movieUrl.includes("lakvision") ||
        movieUrl.includes("slanimeclub") ||
        movieUrl.includes("anime");

      let lastProgressEdit = 0;
      if (isGDrive) {
        logger.info(`Starting high-speed Google Drive download for ${title}...`);
        await downloadGDriveFile(movieUrl, tempFilePath, resolvedQuality);
      } else {
        logger.info(`Downloading video from ${directUrl} to ${tempFilePath}`);
        await downloadFile(directUrl, tempFilePath, (downloaded, total, speed_mb) => {
          const now = Date.now();
          const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          if (now - lastProgressEdit > 3000 || percent % 20 === 0) {
            lastProgressEdit = now;
            const dMB = Math.round(downloaded / (1024 * 1024));
            const tMB = Math.round(total / (1024 * 1024));
            const speedText = speed_mb && speed_mb > 0 ? `${speed_mb} MB/s` : "Ultra High-Speed CDN";
            if (liveStatusMsg?.key) {
              waSocket.sendMessage(replyTarget, {
                text: 
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *චිත්‍රපටය:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
⏳ *තත්ත්වය:* බාගත වෙමින් පවතී...
📥 *Download Progress:* ${percent}% (${dMB}MB / ${tMB}MB)
⚡ *Speed:* ${speedText} (8x Multi-Stream)
━━━━━━━━━━━━━━━━━━━━`,
                edit: liveStatusMsg.key,
              }).catch(() => {});
            }
          }
        });
      }

      // 2. Verify file exists on disk and is non-zero
      if (!fs.existsSync(tempFilePath)) {
        throw new Error("ගොනුව බාගත කිරීම අසාර්ථක විය. File not created on disk.");
      }
      const finalFileSize = fs.statSync(tempFilePath).size;
      if (finalFileSize < 1000000) {
        throw new Error(`බාගත කිරීමේදී දෝෂයක් සිදු විය (ගොනුව ${Math.round(finalFileSize / 1024)}KB ලෙස ලැබුණි, 0MB දෝෂයකි).`);
      }

      const finalSizeMB = Math.round(finalFileSize / (1024 * 1024));
      logger.info(`Download verified! Final file size on disk: ${finalSizeMB}MB.`);

      // Update Live Status Message: Uploading
      if (liveStatusMsg?.key) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *චිත්‍රපටය:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
✅ *Download:* 100% සම්පූර්ණයි (${finalSizeMB}MB)
📤 *Uploading:* WhatsApp සමූහය වෙත යවමින් පවතී...
⚡ *Status:* Group Broadcast in Progress
━━━━━━━━━━━━━━━━━━━━`,
          edit: liveStatusMsg.key,
        }).catch(() => {});
      }

      // 3. Send Poster to WhatsApp Group ONLY AFTER download is complete & verified
      const caption = 
`🎬 *${title}*
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${mentionTag} (${pushName})
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
🌟 *Quality:* ${resolvedQuality} ${movieData.size_text ? `(${movieData.size_text})` : `(${finalSizeMB}MB)`}
🔑 *Token:* ${token || "DIRECT"}
⚡ *Audio / Sub:* Sinhala Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📝 *Storyline / සාරාංශය:*
${movieData.description ? movieData.description.substring(0, 420) + "..." : "FilmFeed Direct Release"}

🍿 _චිත්‍රපටය පහතින් Document එකක් ලෙස ලැබෙනු ඇත!_`;

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

      // 4. Upload Document to all groups
      logger.info(`Uploading ${finalSizeMB}MB document to WhatsApp groups...`);
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

      // 5. Delete temp file from disk
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // 6. Delete intermediate status messages from user's chat
      for (const k of statusTrackerKeys) {
        try {
          await waSocket.sendMessage(replyTarget, { delete: k });
        } catch (_) {}
      }

      // 7. Record movie in user's history and send final summary
      const updatedStats = incrementUserRequest(requesterJid || replyTarget, pushName, title, resolvedQuality);
      const historyList = (updatedStats.history || []).slice(-10);
      let historyText = "";
      historyList.forEach((item, idx) => {
        historyText += `\n${idx + 1}. 🎬 ${item.title} *(${item.quality})* - _${item.date}_`;
      });

      await waSocket.sendMessage(replyTarget, {
        text: 
`🎉 *[FilmFeed Auto-Bot]* සාර්ථකයි!
━━━━━━━━━━━━━━━━━━━━
👤 *සාමාජිකයා:* ${pushName} [${updatedStats.badge}]
🎬 *නිකුත් වූ චිත්‍රපටය:* *${title}* (${resolvedQuality})
📦 *ප්‍රමාණය:* ${finalSizeMB}MB
⚡ *තත්ත්වය:* සමූහය වෙත සාර්ථකව යවන ලදී (Broadcast Complete)

📜 *ඔබ මෙතෙක් ලබාගත් චිත්‍රපට ලැයිස්තුව (${updatedStats.count}):*${historyText}
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed Group එකෙන් දැන්ම Download කරගන්න!
👉 Website: https://web-umber-six-e1un7z6257.vercel.app`,
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
  await cloudSession.restore();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  logger.info(`Starting WhatsApp Bot v${version.join(".")} (Latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || "info" }),
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    browser: Browsers.ubuntu("Chrome"),
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    defaultQueryTimeoutMs: 300000,
    mediaUploadTimeoutMs: 600000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 5000,
    maxMsgRetryCount: 3,
    getMessage: async (key) => {
      return { conversation: "" };
    },
  });

  waSocket = sock;

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    cloudSession.scheduleSync();
  });

  // Auto-sync vault periodically every 15 minutes to keep keys & stats updated
  if (!global.periodicSyncStarted) {
    global.periodicSyncStarted = true;
    setInterval(async () => {
      if (isConnected) {
        try {
          await cloudSession.sync();
          logger.info("☁️ [AutoSync] Periodic session vault sync completed successfully.");
        } catch (e) {
          logger.warn(`☁️ [AutoSync] Periodic sync skipped: ${e.message}`);
        }
      }
    }, 15 * 60 * 1000);

    // 4.8 Hours Graceful Runner Rotation (prevents hard kills by GitHub Actions)
    const RUNNER_LIFETIME_HOURS = parseFloat(process.env.RUNNER_LIFETIME_HOURS || "4.8");
    if (RUNNER_LIFETIME_HOURS > 0) {
      const lifetimeMs = RUNNER_LIFETIME_HOURS * 60 * 60 * 1000;
      setTimeout(async () => {
        logger.info(`⏰ [Rotation] Scheduled ${RUNNER_LIFETIME_HOURS}h runner rotation. Syncing cloud vault...`);
        try {
          await cloudSession.sync();
          logger.info("☁️ [Rotation] Cloud vault sync complete.");
        } catch (e) {
          logger.warn(`☁️ [Rotation] Vault sync error: ${e.message}`);
        }
        logger.info("👋 Exiting cleanly for next continuous runner.");
        process.exit(0);
      }, lifetimeMs);
    }
  }

  // Pairing code only when explicitly requested, to avoid conflict with QR handshake
  if (process.env.USE_PAIRING_CODE === "true" && !state.creds.registered && BOT_PHONE) {
    setTimeout(async () => {
      try {
        if (!sock.authState.creds.registered) {
          const code = await sock.requestPairingCode(BOT_PHONE);
          console.log("\n========================================================");
          console.log(`🔥 [FILMFEED 8-DIGIT PAIRING CODE]: ${code}`);
          console.log(`👉 Open WhatsApp on ${BOT_PHONE} -> Linked Devices -> Link with Phone Number`);
          console.log(`👉 Enter pairing code: ${code}`);
          console.log("========================================================\n");
        }
      } catch (err) {
        logger.warn(`Could not request pairing code: ${err.message}`);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      isConnected = false;
      const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=" + encodeURIComponent(qr);
      console.log("\n==================================================");
      console.log("📲 SCAN THE QR CODE BELOW WITH WHATSAPP (0760372547):");
      console.log("==================================================");
      qrcode.generate(qr, { small: true });
      console.log("\n👉 Web QR Link: " + qrUrl + "\n");

      // Auto-publish QR link to Gist for instant 1-click access
      const ghToken = process.env.GH_PAT || process.env.GITHUB_TOKEN;
      const vaultId = process.env.SESSION_VAULT_ID || "8f37b6dbcf07ff6fab07b21cc8cbe05b";
      if (ghToken && vaultId) {
        axios.patch(`https://api.github.com/gists/${vaultId}`, {
          files: {
            "latest_qr.txt": { content: qrUrl },
          },
        }, {
          headers: {
            Authorization: "Bearer " + ghToken,
            Accept: "application/vnd.github+json",
            "User-Agent": "FilmFeed-QR",
          },
          timeout: 8000,
        }).catch((e) => console.warn("[QR Gist Sync] error:", e.message));
      }
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn(
        `Connection closed (code: ${statusCode}, error: ${lastDisconnect?.error}). Reconnecting...`
      );

      if (isLoggedOut) {
        logger.warn("Session logged out by user. Clearing auth directory...");
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (_) {}
      }

      const delay = statusCode === 515 ? 1000 : 3000;
      setTimeout(startBot, delay);
    } else if (connection === "open") {
      latestQR = null;
      isConnected = true;
      logger.info(`✅ FilmFeed Bot Connected successfully! Active on: ${BOT_PHONE}`);
      logger.info(`🎯 Target Group: ${TARGET_GROUP_JID}`);
      await cloudSession.sync();
      try {
        const credsPath = path.join(AUTH_DIR, "creds.json");
        if (fs.existsSync(credsPath)) {
          const b64 = Buffer.from(fs.readFileSync(credsPath)).toString("base64");
          console.log(`🔑 [PERMANENT_SESSION_KEY]: ${b64.slice(0, 40)}... (Vault Synced)`);
        }
      } catch (_) {}
      processQueue();
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (!m.messages || m.messages.length === 0) return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      try {
        const remoteJid = msg.key.remoteJid || "";
        const fromMe = Boolean(msg.key.fromMe);
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

        // Unwrap potential layers: ephemeral, viewOnce, document captions
        let innerMsg = msg.message;
        if (innerMsg.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
        if (innerMsg.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
        if (innerMsg.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;
        if (innerMsg.documentWithCaptionMessage?.message) innerMsg = innerMsg.documentWithCaptionMessage.message;

        const rawText =
          innerMsg.conversation ||
          innerMsg.extendedTextMessage?.text ||
          innerMsg.imageMessage?.caption ||
          innerMsg.videoMessage?.caption ||
          "";

        const text = rawText.trim();

        if (text) {
          console.log(`📩 [Msg Received] from: ${pushName} (${remoteJid}) | fromMe: ${fromMe}:\n${text}`);
        }

        let commandFound = false;
        let isSeriesSeason = false;
        let seasonNumber = 1;
        let movieUrl = "";
        let quality = "720p";
        let token = "";

        const textLines = text.split("\n");

        // 1. Line-by-line check for commands (prevents false matches on headers like *Request Source:*)
        for (const rawLine of textLines) {
          const line = rawLine.trim();
          if (!line) continue;

          // 1A. Season Command: !req_season, /season, .season, or !req <url> | S1
          const sMatch =
            line.match(/^[!/.]?(?:req_season|season)\s+([^\s|]+)(?:\s*\|\s*[Ss]?(\d+))?(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i) ||
            line.match(/^[!/.]?req(?:uest)?\s+([^\s|]+)\s*\|\s*[Ss](\d+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);

          if (sMatch && (sMatch[1].startsWith("http") || sMatch[1].includes("cinesubz") || sMatch[1].includes("sinhalasub"))) {
            commandFound = true;
            isSeriesSeason = true;
            movieUrl = sMatch[1].trim();
            seasonNumber = sMatch[2] ? parseInt(sMatch[2].trim(), 10) : 1;
            quality = sMatch[3] ? sMatch[3].trim() : "720p";
            token = sMatch[4] ? sMatch[4].trim() : "";
            break;
          }

          // 1B. Movie Command: !req <url> | <quality> | <token>
          const rMatch = line.match(/^[!/.]?req(?:uest)?\s+(https?:\/\/[^\s|]+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);
          if (rMatch) {
            commandFound = true;
            movieUrl = rMatch[1].trim();
            quality = rMatch[2] ? rMatch[2].trim() : "720p";
            token = rMatch[3] ? rMatch[3].trim() : "";
            if (movieUrl.includes("/tvshows/")) {
              isSeriesSeason = true;
              seasonNumber = 1;
            }
            break;
          }
        }

        // 2. Fallback: Search anywhere for a CineSubz or SinhalaSub URL if no formal command was triggered
        if (!commandFound) {
          const urlMatch = text.match(/(https?:\/\/[^\s|]*(?:cinesubz|sinhalasub)[^\s|\n]*)/i);
          if (urlMatch) {
            commandFound = true;
            movieUrl = urlMatch[1].trim();
            quality = "720p";
            token = "DIRECT";
            if (movieUrl.includes("/tvshows/")) {
              isSeriesSeason = true;
              seasonNumber = 1;
            }
          }
        }

        if (!commandFound || !movieUrl) continue;

        logger.info(`🎯 Accepted FilmFeed command from ${pushName} (${remoteJid}): URL=${movieUrl} | Q=${quality}`);

        const replyTarget = remoteJid;
        const userStats = incrementUserRequest(senderPhone, pushName);
        const { count, badge } = userStats;

        // Instant Acknowledgment Message
        try {
          await waSocket.sendMessage(replyTarget, {
            text: `📥 *[FilmFeed Auto-Bot]*\n\n*${pushName}*, ඔබගේ ඉල්ලීම පද්ධතියට ලැබුණි! 🎬\n\n📌 *Quality:* ${quality}\n⏳ බාගත කිරීම සඳහා පෝලිමට එක් කරන ලදී...`,
            mentions: mentionsList,
          });
        } catch (_) {}

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
දැනට වෙනත් චිත්‍රපටයක් බාගත වෙමින් පවතී.

📊 *ඔබගේ පෝලිම් ස්ථානය (Queue Position):* *#${queuePosition}*
📦 *ඉල්ලීම:* ${isSeriesSeason ? `TV Series (Season ${seasonNumber})` : "Movie"}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
📺 *Quality:* ${quality}
🔑 *Token:* ${token}

_කලින් ඉල්ලීම් අවසන් වූ සැණින් ඔබගේ ඉල්ලීම බාගත කර Group එකට Upload වනු ඇත! ස්තූතියි!_`;

          await waSocket.sendMessage(replyTarget, {
            text: queueMessage,
            mentions: mentionsList,
          });
        } else {
          requestQueue.push(taskItem);

          const startMessage = 
`🚀 *[FilmFeed Auto-Bot] සකසමින් පවතී (Processing)*

ආයුබෝවන් *${pushName}* (${mentionTag})!
ඔබගේ *${count}* වන ඉල්ලීම ලැබුණා [${badge}].
${isSeriesSeason ? `📺 *TV Series (Season ${seasonNumber}) Pack* සකස් කිරීම ආරම්භ විය...` : "🎬 Direct High-Speed ලින්ක් එක සකසා බාගත කිරීම ආරම්භ විය..."}

📺 *Quality:* ${quality}
🔑 *Token:* ${token}`;

          await waSocket.sendMessage(replyTarget, {
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
