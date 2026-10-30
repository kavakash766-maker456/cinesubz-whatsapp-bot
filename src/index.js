require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const axios = require("axios");
const CloudSession = require("./cloud_session");
const { broadcastDailyNews } = require("./daily_news");
const { registerBotInFirestore } = require("./firebase_sync");

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

const MAX_FILE_SIZE_BYTES = 1950 * 1024 * 1024; // 1.95 GB Safe WhatsApp Document Limit (MMS rejects >= 2GB with HTTP 413)

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
// Anti-Delete Message Cache (LRU Ring Buffer)
// --------------------------------------------------------------------------
const messageCache = new Map();
const MAX_MESSAGE_CACHE = 2000;

// --------------------------------------------------------------------------
// Processed Message ID Deduplication (Prevent Duplicate Baileys Delivery)
// --------------------------------------------------------------------------
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 2000;

function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.add(msgId);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const firstKey = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstKey);
  }
  return false;
}

// --------------------------------------------------------------------------
// Request Queue System (FIFO - Strict Concurrency Lock)
// --------------------------------------------------------------------------
const requestQueue = [];
let isProcessingQueue = false;
let currentProcessingItem = null;

function triggerQueue() {
  if (isProcessingQueue || requestQueue.length === 0 || !waSocket) return;
  processQueue().catch((err) => {
    logger.error({ err }, "Unhandled error during processQueue");
  });
}

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

function saveUserStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8");
  } catch (e) {
    logger.error({ e }, "Error saving stats file");
  }
}

// --------------------------------------------------------------------------
// Group Upload Deduplication (Same Day Protection)
// --------------------------------------------------------------------------
const DAILY_UPLOADS_FILE = path.join(AUTH_DIR, "daily_uploads.json");

function getDailyUploads() {
  try {
    if (fs.existsSync(DAILY_UPLOADS_FILE)) {
      return JSON.parse(fs.readFileSync(DAILY_UPLOADS_FILE, "utf8"));
    }
  } catch (e) {
    logger.error({ e }, "Error reading daily uploads file");
  }
  return {};
}

function saveDailyUploads(uploads) {
  try {
    fs.writeFileSync(DAILY_UPLOADS_FILE, JSON.stringify(uploads, null, 2), "utf8");
  } catch (e) {
    logger.error({ e }, "Error saving daily uploads file");
  }
}

function normalizeKey(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/www\./, "")
    .replace(/cinesubz\.(net|co|lk)/, "")
    .replace(/sinhalasub\.(net|co|lk)/, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function extractMediaSlug(url, title = "") {
  if (url) {
    const parts = String(url).split("?")[0].split("#")[0].split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1] || "";
    const clean = lastPart
      .replace(/sinhala[-_\s]*subtitles?|sinhala[-_\s]*sub|සිංහල[-_\s]*උපසිරැසි.*/gi, "")
      .replace(/[-_]?(?:19\d\d|20\d\d)[-_]?/g, "")
      .replace(/(?:tv[-_\s]*series|movie|s\d+[-_]?e\d+|\d+\s*[x×]\s*\d+|episode[-_\s]*\d+)/gi, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase()
      .trim();
    if (clean.length >= 3) return clean;
  }
  if (title) {
    const clean = String(title)
      .replace(/sinhala[-_\s]*subtitles?|sinhala[-_\s]*sub|සිංහල[-_\s]*උපසිරැසි.*/gi, "")
      .replace(/[-_]?(?:19\d\d|20\d\d)[-_]?/g, "")
      .replace(/(?:tv[-_\s]*series|movie|s\d+[-_]?e\d+|\d+\s*[x×]\s*\d+|episode[-_\s]*\d+)/gi, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase()
      .trim();
    if (clean.length >= 3) return clean;
  }
  return "";
}

function isAlreadyUploadedToday(cleanUrl, title = "", seasonNumber = null) {
  const uploads = getDailyUploads();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayItems = uploads[todayStr] || [];

  const targetKeyUrl = normalizeKey(cleanUrl);
  const targetKeyTitle = normalizeKey(title);
  const targetSlug = extractMediaSlug(cleanUrl, title);

  return todayItems.some((item) => {
    if (seasonNumber && item.seasonNumber && item.seasonNumber !== seasonNumber) {
      return false;
    }
    const itemKeyUrl = normalizeKey(item.url || item.cleanUrl);
    const itemKeyTitle = normalizeKey(item.title);
    const itemSlug = item.slug || extractMediaSlug(item.url || item.cleanUrl, item.title);

    if (targetKeyUrl && itemKeyUrl && targetKeyUrl === itemKeyUrl) return true;
    if (targetKeyTitle && itemKeyTitle && targetKeyTitle === itemKeyTitle && targetKeyTitle.length >= 4) return true;
    if (targetSlug && itemSlug && targetSlug === itemSlug && targetSlug.length >= 4) return true;
    return false;
  });
}

function recordDailyUpload(cleanUrl, title, isSeriesSeason = false, seasonNumber = null) {
  const uploads = getDailyUploads();
  const todayStr = new Date().toISOString().slice(0, 10);
  if (!uploads[todayStr]) {
    uploads[todayStr] = [];
  }

  // Prune history older than 3 days
  for (const dateKey of Object.keys(uploads)) {
    if (dateKey !== todayStr) {
      const diffDays = (new Date(todayStr) - new Date(dateKey)) / (1000 * 60 * 60 * 24);
      if (diffDays > 3) delete uploads[dateKey];
    }
  }

  const slug = extractMediaSlug(cleanUrl, title);

  uploads[todayStr].push({
    url: cleanUrl,
    title: title || "",
    slug,
    isSeriesSeason: Boolean(isSeriesSeason),
    seasonNumber: seasonNumber || null,
    timestamp: Date.now(),
  });
  saveDailyUploads(uploads);
  logger.info(`[Daily Upload Archive] Recorded today's group upload: ${title || cleanUrl} (Series: ${isSeriesSeason}, S${seasonNumber})`);
}

function checkAndResetDaily(userRecord) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (userRecord.dailyDate !== todayStr) {
    userRecord.dailyDate = todayStr;
    userRecord.dailyCount = 0;
    userRecord.requestedUrls = [];
  }
}

function incrementUserRequest(userId, userName, movieTitle, quality) {
  const stats = getUserStats();
  if (!stats[userId]) {
    stats[userId] = {
      count: 0,
      name: userName,
      firstSeen: new Date().toISOString(),
      history: [],
      dailyCount: 0,
      dailyDate: new Date().toISOString().slice(0, 10),
      isVip: false,
      isBanned: false,
    };
  }
  if (!stats[userId].history) {
    stats[userId].history = [];
  }
  checkAndResetDaily(stats[userId]);

  stats[userId].count += 1;
  stats[userId].dailyCount = (stats[userId].dailyCount || 0) + 1;
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

  saveUserStats(stats);

  const count = stats[userId].count;
  const history = stats[userId].history || [];
  let badge = "🌟 Verified Member";
  if (count >= 20) badge = "👑 VIP Cinema Member";
  else if (count >= 10) badge = "🎬 Senior Cinema Member";
  else if (count >= 5) badge = "🍿 FilmFeed Member";
  else badge = "🌟 Verified Member";

  return { count, badge, history, isVip: Boolean(stats[userId].isVip), isBanned: Boolean(stats[userId].isBanned) };
}

// --------------------------------------------------------------------------
// Group Membership & Invite Manager
// --------------------------------------------------------------------------
const groupMetadataCache = new Map();
const groupInviteCache = new Map();
const pendingGroupRequests = new Map(); // cleanPhoneOrJid -> { taskItem, createdAt }

async function getCachedGroupMetadata(sock, jid, forceRefresh = false) {
  if (!sock) return null;
  const cached = groupMetadataCache.get(jid);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < 3 * 60 * 1000) {
    return cached.data;
  }
  try {
    const data = await sock.groupMetadata(jid);
    groupMetadataCache.set(jid, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    logger.warn({ jid, err: err.message }, "Could not fetch group metadata");
    return cached ? cached.data : null;
  }
}

async function getGroupInviteLink(sock, jid) {
  if (groupInviteCache.has(jid)) return groupInviteCache.get(jid);

  const envKey = `INVITE_${jid.split("@")[0]}`;
  if (process.env[envKey]) {
    groupInviteCache.set(jid, process.env[envKey]);
    return process.env[envKey];
  }

  if (sock) {
    try {
      const code = await sock.groupInviteCode(jid);
      if (code) {
        const link = `https://chat.whatsapp.com/${code}`;
        groupInviteCache.set(jid, link);
        return link;
      }
    } catch (err) {
      logger.warn({ jid, err: err.message }, "Could not fetch group invite code");
    }
  }
  return null;
}

async function checkUserGroups(sock, cleanPhone, userJid, userLid, forceRefresh = false) {
  if (!sock) return [];
  const matched = [];
  for (const jid of TARGET_GROUP_JIDS) {
    const meta = await getCachedGroupMetadata(sock, jid, forceRefresh);
    if (!meta || !meta.participants) continue;

    const inGroup = meta.participants.some((p) => {
      const pId = p.id || "";
      const pLid = p.lid || "";
      const pPhone = pId.split("@")[0].replace(/:\d+/, "");

      if (userJid && pId === userJid) return true;
      if (userLid && (pLid === userLid || pId === userLid)) return true;
      if (cleanPhone && cleanPhone.length >= 9 && cleanPhone.length <= 13 && pPhone === cleanPhone) return true;
      return false;
    });

    if (inGroup) {
      matched.push({
        jid,
        subject: meta.subject || "FilmFeed Cinema Group",
      });
    }
  }
  return matched;
}

async function resolveRealPhoneFromGroups(sock, userLid) {
  if (!sock || !userLid) return null;
  for (const jid of TARGET_GROUP_JIDS) {
    const meta = await getCachedGroupMetadata(sock, jid, false);
    if (!meta || !meta.participants) continue;

    for (const p of meta.participants) {
      const pId = p.id || "";
      const pLid = p.lid || "";
      if (userLid && (pLid === userLid || pId === userLid)) {
        const phone = pId.split("@")[0].replace(/:\d+/, "");
        if (phone && phone.length >= 9 && phone.length <= 13) {
          return phone;
        }
      }
    }
  }
  return null;
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

const TMDB_API_KEY = process.env.TMDB_API_KEY || "b6524bb48fb309af7e940a074a363851";

async function getTmdbMediaDetails(title, isTv = false, year = null) {
  if (!title) return null;
  try {
    let clean = title
      .replace(/\[.*?\]|\(.*?\)/g, " ")
      .replace(/sinhala\s*subtitles?|sinhala\s*sub|සිංහල\s*උපසිරැසි.*/gi, " ")
      .replace(/\|.*$/g, " ")
      .replace(/[:\s]+(?:\d+\s*[x×]\s*\d+|s\d+\s*e\d+|ep(?:isode)?\s*\d+)\b.*/gi, " ")
      .replace(/\b\d+\s*[x×]\s*\d+\b/gi, " ")
      .replace(/\b(tv\s*series|series|complete|incomplete|season\s*\d+|s\d+(?:-\d+)?|ep(?:isode)?\s*\d+)\b/gi, " ")
      .replace(/\b(1080p|720p|480p|360p|2160p|4k|web-dl|bluray|hdrip|dvdrip|x264|x265|hevc|aac)\b/gi, " ")
      .replace(/[-_.]+/g, " ")
      .trim();

    const yMatch = title.match(/\b(19\d\d|20\d\d)\b/);
    const searchYear = year || (yMatch ? yMatch[1] : null);
    clean = clean.replace(/\b(19\d\d|20\d\d)\b/g, "").trim();
    if (!clean) clean = title.trim();

    const endpoint = isTv ? "search/tv" : "search/movie";
    let url = `https://api.themoviedb.org/3/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(clean)}`;
    if (searchYear) {
      url += isTv ? `&first_air_date_year=${searchYear}` : `&year=${searchYear}`;
    }

    const res = await axios.get(url, { timeout: 8000 });
    let results = res.data?.results || [];
    if (results.length === 0 && searchYear) {
      const retryUrl = `https://api.themoviedb.org/3/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(clean)}`;
      const retryRes = await axios.get(retryUrl, { timeout: 8000 });
      results = retryRes.data?.results || [];
    }
    if (results.length === 0 && isTv) {
      const multiUrl = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(clean)}`;
      const multiRes = await axios.get(multiUrl, { timeout: 8000 });
      results = (multiRes.data?.results || []).filter(r => r.media_type === "tv" || r.media_type === "movie");
    }

    if (results.length > 0) {
      const top = results[0];
      const poster = top.poster_path ? `https://image.tmdb.org/t/p/w780${top.poster_path}` : null;
      const backdrop = top.backdrop_path ? `https://image.tmdb.org/t/p/original${top.backdrop_path}` : null;
      return {
        title: top.title || top.name || clean,
        overview: top.overview || "",
        releaseDate: top.release_date || top.first_air_date || "",
        voteAverage: top.vote_average || 0,
        poster,
        backdrop,
      };
    }
  } catch (err) {
    logger.warn(`TMDb lookup notice: ${err.message}`);
  }
  return null;
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

async function downloadTelegramFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const tgScript = path.join(__dirname, "../telegram_downloader.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const args = [tgScript, url, destPath];

    logger.info(`Invoking Telegram MTProto Downloader for: ${url}`);
    const proc = spawn(pythonCmd, args);

    let stdoutData = "";
    let stderrData = "";

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutData += text;
      const progressMatch = text.match(/\[PROGRESS\]\s+([\d.]+)%\s+\((\d+)\/(\d+)\)\s+([\d.]+)\s+MB\/s/);
      if (progressMatch && onProgress) {
        const percent = parseFloat(progressMatch[1]);
        const cur = parseInt(progressMatch[2], 10);
        const total = parseInt(progressMatch[3], 10);
        const speed = parseFloat(progressMatch[4]);
        onProgress(cur, total, speed);
      }
    });

    proc.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    proc.on("close", (code) => {
      try {
        const lines = stdoutData.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        const res = JSON.parse(lastLine);
        if (res.success && fs.existsSync(destPath) && fs.statSync(destPath).size > 100000) {
          logger.info(`Telegram download successful! Size: ${Math.round(res.file_size / 1024 / 1024)}MB`);
          resolve(destPath);
        } else {
          reject(new Error(res.error || stderrData || "Telegram download failed"));
        }
      } catch (e) {
        reject(new Error(stderrData || stdoutData || "Failed to parse telegram downloader output"));
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
// 4B. Poster Thumbnail Buffer & Meta AI Context Info Helpers
// --------------------------------------------------------------------------
const POSTER_STYLER_SCRIPT = path.join(__dirname, "poster_styler.py");

/**
 * Generate crisp 240x320 JPEG thumbnail (< 25KB) for WhatsApp document preview
 */
async function getPosterThumbnail(posterSource, thumbnailB64 = null) {
  if (thumbnailB64) {
    try {
      const buf = Buffer.from(thumbnailB64, "base64");
      if (buf.length > 500 && buf.length < 32000) {
        return buf;
      }
    } catch (_) {}
  }
  if (!posterSource) return null;

  const timestamp = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const tempInPath = path.join(TEMP_DIR, `thumb_in_${timestamp}.jpg`);
  const tempOutPath = path.join(TEMP_DIR, `thumb_out_${timestamp}.jpg`);

  try {
    if (typeof posterSource === "string" && posterSource.startsWith("http")) {
      const pRes = await axios.get(posterSource, {
        responseType: "arraybuffer",
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      fs.writeFileSync(tempInPath, Buffer.from(pRes.data));
    } else if (Buffer.isBuffer(posterSource)) {
      fs.writeFileSync(tempInPath, posterSource);
    } else if (typeof posterSource === "string" && fs.existsSync(posterSource)) {
      fs.copyFileSync(posterSource, tempInPath);
    } else {
      return null;
    }

    await new Promise((resolve, reject) => {
      execFile("python", [POSTER_STYLER_SCRIPT, "thumb", tempInPath, tempOutPath], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (fs.existsSync(tempOutPath)) {
      const thumbBuf = fs.readFileSync(tempOutPath);
      logger.info(`[Document Thumbnail] Generated ${thumbBuf.length} bytes preview card!`);
      return thumbBuf;
    }
  } catch (err) {
    logger.warn(`[Document Thumbnail] Could not generate thumbnail: ${err.message}`);
  } finally {
    try { if (fs.existsSync(tempInPath)) fs.unlinkSync(tempInPath); } catch (_) {}
    try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch (_) {}
  }
  return null;
}

/**
 * Create stunning branded cinema poster with FilmFeed golden gradient banner & requester avatar
 */
async function createPosterWithRequesterAvatar(
  posterSource,
  requesterJid,
  fallbackJid = null,
  requesterName = "VIP Member",
  storyline = null,
  backdropSource = null
) {
  if (!posterSource || !waSocket) {
    return posterSource;
  }

  const primaryJid = requesterJid ? String(requesterJid).trim() : "";
  const secJid = fallbackJid ? String(fallbackJid).trim() : "";

  let avatarUrl = null;
  if (primaryJid) {
    try {
      avatarUrl = await waSocket.profilePictureUrl(primaryJid, "image").catch(() => null);
    } catch (_) {}
  }

  if (!avatarUrl && secJid && secJid !== primaryJid) {
    try {
      avatarUrl = await waSocket.profilePictureUrl(secJid, "image").catch(() => null);
    } catch (_) {}
  }

  const timestamp = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const tempPosterPath = path.join(TEMP_DIR, `poster_raw_${timestamp}.jpg`);
  const tempBackdropPath = path.join(TEMP_DIR, `backdrop_raw_${timestamp}.jpg`);
  const tempAvatarPath = path.join(TEMP_DIR, `avatar_raw_${timestamp}.jpg`);
  const tempStoryPath = path.join(TEMP_DIR, `story_${timestamp}.txt`);
  const tempOutPath = path.join(TEMP_DIR, `branded_poster_${timestamp}.jpg`);

  try {
    // 1. Fetch or copy poster source
    if (typeof posterSource === "string" && posterSource.startsWith("http")) {
      const pRes = await axios.get(posterSource, {
        responseType: "arraybuffer",
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      fs.writeFileSync(tempPosterPath, Buffer.from(pRes.data));
    } else if (Buffer.isBuffer(posterSource)) {
      fs.writeFileSync(tempPosterPath, posterSource);
    } else if (typeof posterSource === "string" && fs.existsSync(posterSource)) {
      fs.copyFileSync(posterSource, tempPosterPath);
    } else {
      return posterSource;
    }

    // 2. Fetch backdrop if available
    let hasBackdrop = false;
    const bdSrc = backdropSource || posterSource;
    if (typeof bdSrc === "string" && bdSrc.startsWith("http")) {
      try {
        const bRes = await axios.get(bdSrc, {
          responseType: "arraybuffer",
          timeout: 10000,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        fs.writeFileSync(tempBackdropPath, Buffer.from(bRes.data));
        hasBackdrop = true;
      } catch (_) {}
    } else if (Buffer.isBuffer(bdSrc)) {
      fs.writeFileSync(tempBackdropPath, bdSrc);
      hasBackdrop = true;
    } else if (typeof bdSrc === "string" && fs.existsSync(bdSrc)) {
      fs.copyFileSync(bdSrc, tempBackdropPath);
      hasBackdrop = true;
    }

    // 3. Fetch avatar if available
    let hasAvatar = false;
    if (avatarUrl) {
      try {
        const aRes = await axios.get(avatarUrl, {
          responseType: "arraybuffer",
          timeout: 8000,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        fs.writeFileSync(tempAvatarPath, Buffer.from(aRes.data));
        hasAvatar = true;
      } catch (_) {}
    }

    // 4. Save storyline text to temp file
    if (storyline) {
      fs.writeFileSync(tempStoryPath, String(storyline), "utf8");
    }

    const cleanName = (requesterName || "VIP Member").replace(/[\r\n\t]/g, " ").trim();
    const avatarArg = hasAvatar ? tempAvatarPath : "NONE";
    const storyArg = fs.existsSync(tempStoryPath) ? tempStoryPath : "NONE";
    const backdropArg = hasBackdrop ? tempBackdropPath : "NONE";

    await new Promise((resolve, reject) => {
      execFile(
        "python",
        [POSTER_STYLER_SCRIPT, "brand", tempPosterPath, avatarArg, cleanName, tempOutPath, storyArg, backdropArg],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    if (fs.existsSync(tempOutPath)) {
      const outputBuffer = fs.readFileSync(tempOutPath);
      logger.info(
        `[Poster PiP] 16:9 Branded cinema poster created: ${outputBuffer.length} bytes (avatar: ${hasAvatar})`
      );
      return outputBuffer;
    }
  } catch (err) {
    logger.warn(`[Poster PiP] Branded poster styling failed: ${err.message}. Falling back to original.`);
  } finally {
    try { if (fs.existsSync(tempPosterPath)) fs.unlinkSync(tempPosterPath); } catch (_) {}
    try { if (fs.existsSync(tempBackdropPath)) fs.unlinkSync(tempBackdropPath); } catch (_) {}
    try { if (fs.existsSync(tempAvatarPath)) fs.unlinkSync(tempAvatarPath); } catch (_) {}
    try { if (fs.existsSync(tempStoryPath)) fs.unlinkSync(tempStoryPath); } catch (_) {}
    try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch (_) {}
  }

  return posterSource;
}

// Global variable to hold real verified newsletter JID dynamically resolved from WhatsApp
let resolvedNewsletterJid = null;

// Global cached primary group invite link
let primaryGroupLink = "https://chat.whatsapp.com/invite";

// Standard automatic promotional footer for FilmFeed Network
function getPromoFooter() {
  const gLink = (primaryGroupLink && primaryGroupLink !== "https://chat.whatsapp.com/invite")
    ? `
👥 *Official Group:* ${primaryGroupLink}`
    : "";
  return `━━━━━━━━━━━━━━━━━━━━
🌐 *Website:* https://web-umber-six-e1un7z6257.vercel.app${gLink}
📢 *VIP Channel:* https://whatsapp.com/channel/0029Vb9AG1c3GJOsPvzqdu0R`;
}

// Clean, standard WhatsApp message context
function getMetaAiContext(mentionsList = []) {
  if (Array.isArray(mentionsList) && mentionsList.length > 0) {
    return {
      mentionedJid: mentionsList,
    };
  }
  return {};
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
        const https = require("https");
        axios({
          url,
          method: "GET",
          responseType: "stream",
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          timeout: 7200000,
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
    requesterLid,
    cleanPhone,
    pushName,
    mentionTag,
    mentionDisplay,
    mentionsList,
    userStats,
  } = currentTask;
  const { count, badge } = userStats;

  const requesterIdentifier = requesterJid || (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : "") || requesterLid || replyTarget;
  const fallbackIdentifier = requesterLid || (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : null);

  logger.info(
    `[Queue Engine] Processing task for ${pushName}: ${movieUrl} | Type=${isSeriesSeason ? `Series S${seasonNumber}` : "Movie"} | Remaining in queue: ${requestQueue.length}`
  );

  // Helper function to broadcast message to target groups
  const broadcastToGroups = async (payload) => {
    const groupsToSend = (currentTask.targetGroups && currentTask.targetGroups.length > 0)
      ? currentTask.targetGroups
      : TARGET_GROUP_JIDS;

    let sentCount = 0;
    let lastError = null;
    for (const jid of groupsToSend) {
      try {
        await waSocket.sendMessage(jid, payload);
        sentCount++;
      } catch (err) {
        lastError = err;
        logger.error({ err, jid }, `Failed sending to group ${jid}: ${err.message}`);
      }
    }
    if (sentCount === 0 && groupsToSend.length > 0) {
      throw lastError || new Error("WhatsApp message delivery failed to target groups");
    }
  };

  try {
    // ----------------------------------------------------------------------
    // MODE A: TV SERIES SEASON BATCH (Sequential Episode Delivery)
    // ----------------------------------------------------------------------
    if (isSeriesSeason) {
      await waSocket.sendMessage(replyTarget, {
        text:
`📺 *FILMFEED CINEMA • TV SERIES DISPATCH*
━━━━━━━━━━━━━━━━━━━━
👤 *Requester:* ${pushName} (${mentionTag}) [${badge}]
📦 *Series:* Season ${seasonNumber} Pack
⚡ *Status:* Initializing episode queue. Episodes will broadcast sequentially to the group.
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
        mentions: mentionsList,
        contextInfo: getMetaAiContext(mentionsList),
      });

      const seriesData = await resolveSeriesEpisodes(movieUrl);
      let episodes = seriesData.episodes || [];

      // Filter by requested season if season number given
      if (seasonNumber) {
        const seasonEps = episodes.filter((ep) => ep.season === seasonNumber);
        if (seasonEps.length > 0) episodes = seasonEps;
        else {
          // Check if any episode title contains season string
          const sTitleEps = episodes.filter((ep) =>
            new RegExp(`(?:s0?${seasonNumber}|season\\s*0?${seasonNumber})`, "i").test(ep.title || ep.url)
          );
          if (sTitleEps.length > 0) episodes = sTitleEps;
        }
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
          text:
`⚠️ *FILMFEED CINEMA • SYSTEM NOTICE*
━━━━━━━━━━━━━━━━━━━━
📌 *Notice:* Season ${seasonNumber} episodes could not be indexed.
💡 Please verify the season number and request again via our portal.
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        });
        return;
      }

      // High-res TMDb lookup for the TV series
      const tmdb = await getTmdbMediaDetails(seriesData.title || "TV Series", true);
      const showTitle = tmdb?.title || seriesData.title || "TV Series";
      const posterUrl = tmdb?.poster || seriesData.poster || seriesData.backdrop;
      const backdropUrl = tmdb?.backdrop || seriesData.backdrop || posterUrl;
      const overview = tmdb?.overview || seriesData.description || "FilmFeed Cinema Series Release";
      const totalEpisodes = episodes.length;
      let seasonPosterSent = false;

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

          if (directUrl.includes("t.me") || epData.is_telegram) {
            await downloadTelegramFile(directUrl, tempFilePath);
          } else if (epData.is_gdrive || directUrl.includes("drive.google.com")) {
            await downloadGDriveFile(directUrl, tempFilePath, resolvedQuality);
          } else {
            await downloadFile(directUrl, tempFilePath);
          }

          if (!fs.existsSync(tempFilePath) || fs.statSync(tempFilePath).size < 1000000) {
            logger.warn(`Episode ${epTitle} download failed or produced corrupted file (<1MB). Skipping.`);
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            continue;
          }

          // ZERO POSTERS TO GROUP UNTIL FILE IS FULLY DOWNLOADED & VERIFIED!
          if (!seasonPosterSent) {
            const seasonCaption = 
`🎬 *${showTitle} (Season ${seasonNumber})*
──────────────────────
• Release: Complete Season Batch (${totalEpisodes} Episodes)
• Requester: ${currentTask.mentionDisplay || mentionTag}
• Quality: ${quality} [Sinhala Subtitles]
${tmdb?.voteAverage ? `• Rating: ⭐ ${tmdb.voteAverage.toFixed(1)}/10\n` : ""}${tmdb?.releaseDate ? `• Air Date: 📅 ${tmdb.releaseDate}\n` : ""}──────────────────────
📝 *Storyline / සාරාංශය:*
${overview.length > 350 ? overview.substring(0, 350) + "..." : overview}

📥 _Episode 1 සිට ${totalEpisodes} දක්වා සියලුම කොටස් පිළිවෙළින් පහතින් ලැබෙනු ඇත._
${getPromoFooter()}`;

            const effectivePoster = posterUrl || backdropUrl;
            if (effectivePoster) {
              const pipPoster = await createPosterWithRequesterAvatar(
                effectivePoster,
                requesterIdentifier,
                fallbackIdentifier,
                pushName,
                overview,
                backdropUrl
              );
              await broadcastToGroups({
                image: Buffer.isBuffer(pipPoster) ? pipPoster : { url: effectivePoster },
                caption: seasonCaption,
                mentions: mentionsList,
                contextInfo: getMetaAiContext(mentionsList),
              });
            } else {
              await broadcastToGroups({
                text: seasonCaption,
                mentions: mentionsList,
                contextInfo: getMetaAiContext(mentionsList),
              });
            }
            seasonPosterSent = true;
            // Record in daily upload archive
            recordDailyUpload(movieUrl, showTitle, true, seasonNumber);
          }

          const fileBuffer = fs.readFileSync(tempFilePath);
          const epThumbnail = await getPosterThumbnail(posterUrl || epData.poster || epData.backdrop, epData.thumbnail_b64);

          // Upload Episode Document to All Target Groups
          await broadcastToGroups({
            document: fileBuffer,
            mimetype: "video/mp4",
            fileName: `${epTitle} [${resolvedQuality}] [FilmFeed].mp4`,
            caption: 
`🎬 *${epTitle}* (${resolvedQuality})
──────────────────────
• Series: ${showTitle} [Season ${seasonNumber}]
• Progress: Episode ${epIndex} of ${totalEpisodes}
• Requester: ${currentTask.mentionDisplay || mentionTag}
──────────────────────
${getPromoFooter()}`,
            mentions: mentionsList,
            ...(epThumbnail ? { jpegThumbnail: epThumbnail } : {}),
            contextInfo: getMetaAiContext(mentionsList),
          });

          uploadedCount++;

          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }

          await new Promise((r) => setTimeout(r, 2000));
        } catch (epErr) {
          logger.error({ epErr }, `Error downloading episode ${epIndex}`);
        }
      }

      // Send Interactive Poll after ALL episodes are uploaded
      try {
        await broadcastToGroups({
          poll: {
            name: `🍿 "${showTitle} (Season ${seasonNumber})" කතා මාලාව ගැන ඔබේ අදහස?`,
            values: [
              "🔥 සුපිරියක් (Must Watch)",
              "👍 හොඳයි (Good)",
              "😐 සාමාන්‍යයි (Average)",
              "👎 වැඩක් නෑ (Not Recommended)",
              "⏳ තාම බැලුවේ නෑ (Watching Soon)",
            ],
            selectableCount: 1,
          },
        });
      } catch (pErr) {
        logger.warn(`Could not send season poll: ${pErr.message}`);
      }

      // Auto-post TV Series to WhatsApp Status
      try {
        const sPoster = posterUrl || backdropUrl;
        if (sPoster && waSocket) {
          await waSocket.sendMessage("status@broadcast", {
            image: { url: sPoster },
            caption: `📺 *NEW TV SERIES PACK!* 🍿\n━━━━━━━━━━━━━━━━━━━━\n🔥 *${showTitle} (Season ${seasonNumber})*\n📦 All Episodes Uploaded\n⚡ Sinhala Subtitles Included\n\n📥 *Download from our Group:*\n👥 ${primaryGroupLink}\n\n🌐 *Web:* https://web-umber-six-e1un7z6257.vercel.app`,
          });
          logger.info("📢 Auto-posted TV series update to WhatsApp Status!");
        }
      } catch (stErr) {
        logger.warn(`Could not auto-post season to WhatsApp status: ${stErr.message}`);
      }

      // Final Season Completion Notification
      await waSocket.sendMessage(replyTarget, {
        text: 
`🎬 *FILMFEED CINEMA • SERIES PACK COMPLETE*
━━━━━━━━━━━━━━━━━━━━
👤 *Requester:* ${pushName} (${mentionTag}) [${badge}]
📺 *Series:* *${showTitle}* (Season ${seasonNumber})
📦 *Episodes:* ${uploadedCount}/${totalEpisodes} Delivered
⚡ *Status:* Broadcast Complete

🍿 *Available in your official FilmFeed group.*
👉 Website: https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
        mentions: mentionsList,
        contextInfo: getMetaAiContext(mentionsList),
      });

    } else {
      // ----------------------------------------------------------------------
      // MODE B: SINGLE MOVIE PROCESSING
      // ----------------------------------------------------------------------
      const statusTrackerKeys = [];

      const initialQueueMsg = await waSocket.sendMessage(replyTarget, {
        text: 
`🚀 *FILMFEED CINEMA • INITIALIZING DISPATCH*
━━━━━━━━━━━━━━━━━━━━
👤 *Requester:* ${pushName} (${mentionTag}) [${badge}]
📦 *Release:* *${movieUrl.split("/").filter(Boolean).pop().replace(/[-_]/g, " ")}*
🌟 *Format:* ${quality} • High-Speed Stream
⚡ *Status:* Secure resolver active. Starting download...
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
        mentions: mentionsList,
        contextInfo: getMetaAiContext(mentionsList),
      });
      if (initialQueueMsg?.key) statusTrackerKeys.push(initialQueueMsg.key);

      const movieData = await resolveMovie(movieUrl, quality);

      if (!movieData.success || !movieData.direct_url) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`⚠️ *FILMFEED CINEMA • RESOLUTION NOTICE*
━━━━━━━━━━━━━━━━━━━━
📌 *Notice:* Link resolution encountered an issue: ${movieData.error || "Media stream unavailable"}
💡 *Action:* Please verify the link or select an alternate quality via our web portal.
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        });
        return;
      }

      // Query TMDb for ultra high-resolution poster, backdrop, and official metadata
      const rawTitle = movieData.title || "Movie";
      const tmdb = await getTmdbMediaDetails(rawTitle, false);
      const title = tmdb?.title || rawTitle;
      const posterUrl = tmdb?.poster || movieData.poster || movieData.backdrop;
      const backdropUrl = tmdb?.backdrop || movieData.backdrop || posterUrl;
      const overview = tmdb?.overview || movieData.description || "FilmFeed Cinema Direct Release";
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
`⚠️ *FILMFEED CINEMA • FILE SIZE LIMIT EXCEEDED*
━━━━━━━━━━━━━━━━━━━━
👤 *Requester:* ${pushName} (${mentionTag}) [${badge}]
📌 *Release:* *${title}* (${resolvedQuality})
📊 *Detected Size:* ${sizeInGB} (Safe Limit: 1.95 GB)

WhatsApp document specifications enforce a 2GB maximum transfer limit.
💡 *Recommendation:* Please select 720p or 480p format from the portal:
👉 https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`;

        await waSocket.sendMessage(replyTarget, {
          text: sizeAlertMsg,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        });
        return;
      }

      // Live Real-Time Status Tracker Message for Requester
      let liveStatusMsg = null;
      try {
        liveStatusMsg = await waSocket.sendMessage(replyTarget, {
          text: 
`⚡ *FILMFEED CINEMA • STREAMING IN PROGRESS*
━━━━━━━━━━━━━━━━━━━━
📌 *Release:* *${title}* (${resolvedQuality})
👤 *Requester:* ${pushName} [${badge}]
📥 *Progress:* Initializing high-speed pipeline...
⚡ *Engine:* Ultra High-Speed CDN
━━━━━━━━━━━━━━━━━━━━`,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        });
        if (liveStatusMsg?.key) statusTrackerKeys.push(liveStatusMsg.key);
      } catch (_) {}

      // 1. Download Movie File to Disk First
      const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_") + `_${resolvedQuality}.mp4`;
      const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);

      const isTelegram =
        movieData.is_telegram ||
        (directUrl && directUrl.includes("t.me")) ||
        (movieUrl && movieUrl.includes("t.me"));

      const isGDrive =
        !isTelegram &&
        (movieData.is_cartoon ||
        movieData.is_anime ||
        movieData.is_gdrive ||
        movieUrl.includes("drive.google.com") ||
        movieUrl.includes("lakvision") ||
        movieUrl.includes("slanimeclub") ||
        movieUrl.includes("anime"));

      let lastProgressEdit = 0;
      if (isTelegram) {
        logger.info(`Starting Telegram MTProto download for ${title}...`);
        await downloadTelegramFile(directUrl || movieUrl, tempFilePath, (downloaded, total, speed_mb) => {
          const now = Date.now();
          const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          if (now - lastProgressEdit > 3000 || percent % 20 === 0) {
            lastProgressEdit = now;
            const dMB = Math.round(downloaded / (1024 * 1024));
            const tMB = Math.round(total / (1024 * 1024));
            const speedText = speed_mb && speed_mb > 0 ? `${speed_mb} MB/s` : "Ultra Telegram CDN";
            if (liveStatusMsg?.key) {
              waSocket.sendMessage(replyTarget, {
                text: 
`⚡ *FILMFEED CINEMA • STREAMING IN PROGRESS*
━━━━━━━━━━━━━━━━━━━━
📌 *Release:* *${title}* (${resolvedQuality})
👤 *Requester:* ${pushName} [${badge}]
📥 *Progress:* ${percent}% (${dMB}MB / ${tMB}MB)
⚡ *Transfer Rate:* ${speedText} (MTProto Secure Pipeline)
━━━━━━━━━━━━━━━━━━━━`,
                edit: liveStatusMsg.key,
                contextInfo: getMetaAiContext(mentionsList),
              }).catch(() => {});
            }
          }
        });
      } else if (isGDrive) {
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
`⚡ *FILMFEED CINEMA • STREAMING IN PROGRESS*
━━━━━━━━━━━━━━━━━━━━
📌 *Release:* *${title}* (${resolvedQuality})
👤 *Requester:* ${pushName} [${badge}]
📥 *Progress:* ${percent}% (${dMB}MB / ${tMB}MB)
⚡ *Transfer Rate:* ${speedText} (Multi-Stream Pipeline)
━━━━━━━━━━━━━━━━━━━━`,
                edit: liveStatusMsg.key,
                contextInfo: getMetaAiContext(mentionsList),
              }).catch(() => {});
            }
          }
        });
      }

      // 2. Verify file exists on disk and is > 1MB
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
`🎬 *FILMFEED CINEMA • BROADCASTING*
━━━━━━━━━━━━━━━━━━━━
📌 *Title:* *${title}*
🌟 *Format:* ${resolvedQuality} • ${finalSizeMB}MB
👤 *Requester:* ${pushName} [${badge}]
✅ *Integrity:* 100% Verified
📤 *Upload:* Dispatching to Official Groups...
━━━━━━━━━━━━━━━━━━━━
⚡ _Broadcasting high-definition media pack..._`,
          edit: liveStatusMsg.key,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      }

      // 3. ZERO POSTERS SENT UNTIL FILE IS FULLY VERIFIED ON DISK!
      // Send High-Res Poster to WhatsApp Group
      const caption = 
`🎬 *${title}*
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *Member Tier:* ${badge}
🌟 *Quality:* ${resolvedQuality} (${finalSizeMB}MB)
${tmdb?.voteAverage ? `⭐ *TMDb Rating:* ${tmdb.voteAverage.toFixed(1)}/10\n` : ""}${tmdb?.releaseDate ? `📅 *Release Date:* ${tmdb.releaseDate}\n` : ""}🔑 *Token:* ${token || "DIRECT"}
⚡ *Audio / Sub:* Sinhala Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📝 *Storyline / සාරාංශය:*
${overview.length > 350 ? overview.substring(0, 350) + "..." : overview}

🍿 _The release is arriving below as a high-definition document!_\n${getPromoFooter()}`;

      const effectivePoster = posterUrl || backdropUrl;
      if (effectivePoster) {
        const pipPoster = await createPosterWithRequesterAvatar(effectivePoster, requesterIdentifier, fallbackIdentifier, pushName, overview, backdropUrl);
        await broadcastToGroups({
          image: Buffer.isBuffer(pipPoster) ? pipPoster : { url: effectivePoster },
          caption: caption,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        });
      } else {
        await broadcastToGroups({
          text: caption,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        });
      }

      // Record daily upload for deduplication
      recordDailyUpload(movieUrl, title, false, null);

      // 4. Upload Document to all groups with Movie Poster Thumbnail & Meta AI Styling
      logger.info(`Uploading ${finalSizeMB}MB document to WhatsApp groups...`);
      const fileBuffer = fs.readFileSync(tempFilePath);
      const thumbBuffer = await getPosterThumbnail(posterUrl || effectivePoster, movieData?.thumbnail_b64);
      
      await broadcastToGroups({
        document: fileBuffer,
        mimetype: "video/mp4",
        fileName: `${title} [${resolvedQuality}] [FilmFeed].mp4`,
        caption: 
`🎬 *${title}*
━━━━━━━━━━━━━━━━━━━━
🌟 *Quality:* ${resolvedQuality} • ${finalSizeMB}MB
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag} [${badge}]
⚡ *Status:* Official Cinema Release
━━━━━━━━━━━━━━━━━━━━
🍿 _FilmFeed Cinema Media Engine_
${getPromoFooter()}`,
        mentions: mentionsList,
        ...(thumbBuffer ? { jpegThumbnail: thumbBuffer } : {}),
        contextInfo: getMetaAiContext(mentionsList),
      });

      // 4.1. Send Interactive WhatsApp Movie Poll AFTER Document is delivered to groups
      try {
        await broadcastToGroups({
          poll: {
            name: `🍿 "${title}" චිත්‍රපටය ඔබ නැරඹුවාද? ඔබේ අදහස කුමක්ද?`,
            values: [
              "🔥 සුපිරියක් (Must Watch)",
              "👍 හොඳයි (Good)",
              "😐 සාමාන්‍යයි (Average)",
              "👎 වැඩක් නෑ (Not Recommended)",
              "⏳ තාම බැලුවේ නෑ (Watching Soon)",
            ],
            selectableCount: 1,
          },
        });
      } catch (pErr) {
        logger.warn(`Could not send movie poll: ${pErr.message}`);
      }

      // 4.2. Auto-post Movie Drop to WhatsApp Status (mentioning group)
      try {
        if (effectivePoster && waSocket) {
          const statusCaption = 
`🎬 *NEW MOVIE UPLOADED!* 🍿
━━━━━━━━━━━━━━━━━━━━
🔥 *${title}* (${resolvedQuality})
⭐ TMDb Rating: ${tmdb?.voteAverage ? tmdb.voteAverage.toFixed(1) : "7.5"}/10
⚡ Sinhala Subtitles Included (CineSubz)

📥 *Download from our Group:*
👥 ${primaryGroupLink}

🌐 *Web:* https://web-umber-six-e1un7z6257.vercel.app`;

          await waSocket.sendMessage("status@broadcast", {
            image: { url: effectivePoster },
            caption: statusCaption,
          });
          logger.info("📢 Auto-posted movie drop to WhatsApp Status!");
        }
      } catch (stErr) {
        logger.warn(`Could not auto-post to WhatsApp status: ${stErr.message}`);
      }

      // 5. Delete temp file from disk
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // 6. Delete intermediate status messages from user's chat (never in groups to prevent ghost bubbles)
      if (replyTarget && !replyTarget.endsWith("@g.us")) {
        for (const k of statusTrackerKeys) {
          try {
            await waSocket.sendMessage(replyTarget, { delete: k });
          } catch (_) {}
        }
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
`🎬 *FILMFEED CINEMA • RELEASE COMPLETE*
━━━━━━━━━━━━━━━━━━━━
📌 *Title:* *${title}*
🌟 *Format:* ${resolvedQuality} • ${finalSizeMB}MB
👤 *Requester:* ${pushName} [${updatedStats.badge}]
⚡ *Status:* Group Broadcast Successful

📜 *Member History (${updatedStats.count}):*${historyText}
━━━━━━━━━━━━━━━━━━━━
🍿 _The movie is now available in your official FilmFeed group._
👉 Website: https://web-umber-six-e1un7z6257.vercel.app`,
        mentions: mentionsList,
        contextInfo: getMetaAiContext(mentionsList),
      });
    }

  } catch (err) {
    logger.error({ err }, "Error processing queued task");
    await waSocket.sendMessage(replyTarget, {
      text: `⚠️ *FILMFEED CINEMA • SYSTEM NOTICE*\n━━━━━━━━━━━━━━━━━━━━\n❌ Error processing request: ${err.message}`,
      contextInfo: getMetaAiContext(mentionsList),
    });
  } finally {
    isProcessingQueue = false;
    currentProcessingItem = null;
    if (requestQueue.length > 0) {
      setTimeout(triggerQueue, 1500);
    }
  }
}

// --------------------------------------------------------------------------
// 7. WhatsApp Bot Initialization & Event Handler
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// 7. Dual WhatsApp Bot Initialization & Event Handler
// --------------------------------------------------------------------------
const botSockets = {
  movies: null,
  series: null,
};

function attachMessageEvents(sock) {
  sock.ev.on("messages.upsert", async (m) => {
    // Only process new incoming messages — skip history sync replays on startup
    if (m.type !== "notify") return;
    if (!m.messages || m.messages.length === 0) return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      const msgId = msg.key?.id;
      if (isDuplicateMessage(msgId)) {
        continue;
      }

      try {
        const remoteJid = msg.key.remoteJid || "";
        const fromMe = Boolean(msg.key.fromMe);

        // Unwrap potential layers: ephemeral, viewOnce, document captions
        let innerMsg = msg.message;
        if (innerMsg?.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
        if (innerMsg?.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
        if (innerMsg?.documentWithCaptionMessage?.message) innerMsg = innerMsg.documentWithCaptionMessage.message;

        // Extract raw text from any message type
        const text =
          innerMsg?.conversation ||
          innerMsg?.extendedTextMessage?.text ||
          innerMsg?.imageMessage?.caption ||
          innerMsg?.videoMessage?.caption ||
          innerMsg?.documentMessage?.caption ||
          "";

        if (!text || typeof text !== "string") continue;

        const isGroup = remoteJid.endsWith("@g.us");
        const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
        const pushName = msg.pushName || (fromMe ? "Admin" : "Member");

        let requesterLid = (senderJid && senderJid.endsWith("@lid"))
          ? senderJid
          : (msg.key.participant && msg.key.participant.endsWith("@lid") ? msg.key.participant : "");

        let resolvedPhone = null;
        if (requesterLid) {
          try {
            resolvedPhone = await resolveRealPhoneFromGroups(waSocket, requesterLid);
          } catch (_) {}
        }

        const rawPhone = (resolvedPhone || senderJid.split("@")[0]).replace(/:\d+/, "");
        const senderPhone = rawPhone.replace(/\D/g, "");
        const cleanPhone = senderPhone.length === 11 && senderPhone.startsWith("94")
          ? senderPhone
          : senderPhone.length === 10 && senderPhone.startsWith("0")
          ? "94" + senderPhone.slice(1)
          : senderPhone.length === 9
          ? "94" + senderPhone
          : senderPhone;

        const requesterJid = (cleanPhone && cleanPhone.length >= 9 && cleanPhone.length <= 13)
          ? `${cleanPhone}@s.whatsapp.net`
          : (senderJid.endsWith("@s.whatsapp.net") ? senderJid : "");

        const mentionTag = `@${cleanPhone || rawPhone || "user"}`;
        const mentionDisplay = pushName ? `*${pushName}* (${mentionTag})` : mentionTag;
        const mentionsList = requesterJid ? [requesterJid] : [];

        // Admin check: true if sender phone matches BOT_PHONE, known admin numbers, or sent by bot itself
        const adminNumbers = ["94760372547", "94787732040", "94782088603"];
        const isAdmin = fromMe || (cleanPhone && adminNumbers.includes(cleanPhone));

        // ------------------------------------------------------------------
        // Check for Group Join Verification Command: !done / done / verify
        // ------------------------------------------------------------------
        const lowerTrimmed = text.trim().toLowerCase();
        if (["!done", "done", ".done", "/done", "verify", "!verify", "join", "!join"].includes(lowerTrimmed)) {
          const pendingKey = cleanPhone || requesterLid || senderPhone;
          const pending = pendingGroupRequests.get(pendingKey);

          if (pending && pending.taskItem) {
            const userGroups = await checkUserGroups(waSocket, cleanPhone, requesterJid, requesterLid, true);
            if (userGroups.length > 0) {
              const taskItem = pending.taskItem;
              taskItem.targetGroups = userGroups.map((g) => g.jid);
              pendingGroupRequests.delete(pendingKey);

              const groupNames = userGroups.map((g) => `*${g.subject}*`).join(", ");
              await waSocket.sendMessage(remoteJid, {
                text: `✅ *FILMFEED CINEMA • MEMBERSHIP CONFIRMED*\n━━━━━━━━━━━━━━━━━━━━\nWelcome *${pushName}*! Access for ${groupNames} verified.\n\n🚀 Your request for *${taskItem.isSeriesSeason ? `TV Series (Season ${taskItem.seasonNumber}) Pack` : "Movie"}* has been queued for broadcast! 🍿`,
              });

              requestQueue.push(taskItem);
              triggerQueue();
              continue;
            } else {
              await waSocket.sendMessage(remoteJid, {
                text: `⚠️ *FILMFEED CINEMA • MEMBERSHIP REQUIRED*\n━━━━━━━━━━━━━━━━━━━━\nMembership in our official WhatsApp group could not be verified yet. Please tap the group invite link, join the community, and reply *done* to continue.`,
              });
              continue;
            }
          }
        }

        // ------------------------------------------------------------------
        // Parse Commands: Robust Media URL & Parameter Extraction
        // ------------------------------------------------------------------
        let commandFound = false;
        let isSeriesSeason = false;
        let seasonNumber = 1;
        let movieUrl = "";
        let quality = "720p";
        let token = "";

        const textLines = text.split("\n");

        for (const rawLine of textLines) {
          const line = rawLine.trim();
          if (!line) continue;

          // Check if line contains a supported media URL
          const urlMatch = line.match(/(https?:\/\/[^\s|]*(?:cinesubz|sinhalasub|baiscopes|animekaizen|cartoons|drive\.google)[^\s|]*)/i);
          const isExplicitSeasonCmd = /^[!/.]?(?:req_season|season)\b/i.test(line);

          if (urlMatch) {
            commandFound = true;
            movieUrl = urlMatch[1].trim();

            if (isExplicitSeasonCmd) {
              isSeriesSeason = true;
            }

            // Extract the remainder of the line excluding the URL
            const remainder = line.replace(urlMatch[0], " ").trim();
            // Split remainder by pipe, comma, or whitespace
            const tokens = remainder.split(/[|\s,]+/).map((t) => t.trim()).filter(Boolean);

            for (const t of tokens) {
              if (/^[!/.]?(?:req(?:uest)?|req_season|season)$/i.test(t)) continue;
              const sMatch = t.match(/^(?:s|season\s*)?(\d{1,3})$/i);
              const qMatch = t.match(/^(?:360p|480p|720p|1080p|2160p|4k|sd|hd|fhd)$/i);

              if (sMatch && (isExplicitSeasonCmd || !t.toLowerCase().endsWith("p"))) {
                seasonNumber = parseInt(sMatch[1], 10);
                isSeriesSeason = true;
              } else if (qMatch || /^\d{3,4}p$/i.test(t)) {
                quality = t;
              } else if (!token) {
                token = t;
              }
            }
            break;
          }
        }

        // Fallback: Search anywhere in message text for CineSubz, SinhalaSub, Baiscopes, Anime or Cartoons URL
        if (!commandFound) {
          const urlMatch = text.match(/(https?:\/\/[^\s|]*(?:cinesubz|sinhalasub|baiscopes|animekaizen|cartoons)[^\s|\n]*)/i);
          if (urlMatch) {
            commandFound = true;
            movieUrl = urlMatch[1].trim();
            quality = "720p";
            token = "DIRECT";
          }
        }

        // If not a command or recognized media link, ignore immediately
        if (!commandFound || !movieUrl) {
          continue;
        }

        // Check if URL inherently belongs to a TV series or episode
        const isSeriesUrl = /\/(?:tvshows|tv-series|series|episodes)\//i.test(movieUrl) || movieUrl.includes("anime") || movieUrl.includes("cartoons");
        if (isSeriesUrl) {
          isSeriesSeason = true;
          // Extract season from episode URL if not already explicitly specified
          if (seasonNumber === 1) {
            const epSeasonMatch = movieUrl.match(/(?:s|season[-_]?)(\d{1,2})e\d+/i) || movieUrl.match(/[-_](\d{1,2})x\d+/i) || movieUrl.match(/season[-_]?(\d{1,2})/i);
            if (epSeasonMatch) {
              seasonNumber = parseInt(epSeasonMatch[1], 10);
            }
          }
        }

        // Normalize domain to cinesubz.lk
        movieUrl = movieUrl.replace(/cinesubz\.(net|co)/g, "cinesubz.lk");
        const cleanUrl = movieUrl.trim().toLowerCase().replace(/\/+$/, "");

        logger.info(`🎯 Accepted FilmFeed request from ${pushName} (${remoteJid}): URL=${movieUrl} | Q=${quality} | Type=${isSeriesSeason ? `Series S${seasonNumber}` : "Movie"}`);

        const replyTarget = remoteJid;

        // User stats
        const stats = getUserStats();
        if (!stats[senderPhone]) {
          stats[senderPhone] = {
            count: 0,
            name: pushName,
            firstSeen: new Date().toISOString(),
            history: [],
            dailyCount: 0,
            dailyDate: new Date().toISOString().slice(0, 10),
            requestedUrls: [],
            isVip: false,
            isBanned: false,
            banExpires: null,
          };
        }
        const userRecord = stats[senderPhone];
        checkAndResetDaily(userRecord);

        if (isAdmin) {
          userRecord.isVip = true;
          userRecord.isBanned = false;
          userRecord.banExpires = null;
        }

        if (text.includes("👑 VIP Member") || text.includes("VIP") || token.toUpperCase().includes("VIP") || text.includes("👑")) {
          userRecord.isVip = true;
          saveUserStats(stats);
        }

        // ------------------------------------------------------------------
        // Check 1: User Ban Status (5-Hour Spam Ban or Admin Suspension)
        // ------------------------------------------------------------------
        if (!isAdmin && userRecord.isBanned) {
          if (userRecord.banExpires && Date.now() < userRecord.banExpires) {
            const remainingMs = userRecord.banExpires - Date.now();
            const remainingHours = Math.floor(remainingMs / (3600 * 1000));
            const remainingMins = Math.max(1, Math.ceil((remainingMs % (3600 * 1000)) / (60 * 1000)));
            logger.warn(`🚫 Request ignored from temporarily banned user ${senderPhone} (${pushName}) - ${remainingHours}h ${remainingMins}m remaining`);
            await waSocket.sendMessage(replyTarget, {
              text:
`🚫 *FILMFEED SECURITY • ACCESS SUSPENDED*
━━━━━━━━━━━━━━━━━━━━
👤 *Member:* ${pushName} (+${senderPhone})
⏳ *Lockout Time:* ${remainingHours}h ${remainingMins}m remaining
⚠️ *Reason:* Multiple/duplicate automated requests.

Access to bot operations is temporarily locked. Service will automatically resume once the suspension period expires.
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed Security Enforcement*`,
              mentions: mentionsList,
              contextInfo: getMetaAiContext(mentionsList),
            });
            continue;
          } else if (userRecord.banExpires && Date.now() >= userRecord.banExpires) {
            // Ban has expired - automatically restore user access
            userRecord.isBanned = false;
            userRecord.banExpires = null;
            saveUserStats(stats);
            logger.info(`✅ 5-hour ban expired for user ${senderPhone}. Access restored.`);
          } else {
            // Permanent admin ban
            await waSocket.sendMessage(replyTarget, {
              text: `🚫 *FILMFEED SECURITY • ACCOUNT SUSPENDED*\n━━━━━━━━━━━━━━━━━━━━\n👤 *User:* +${senderPhone}\n⚠️ Your account has been suspended by the administrator. Contact Admin (+94760372547) for assistance.`,
              mentions: mentionsList,
              contextInfo: getMetaAiContext(mentionsList),
            });
            continue;
          }
        }

        // ------------------------------------------------------------------
        // Check 2: Same-Day Group Upload Deduplication
        // The same movie or TV series cannot be uploaded to the target group twice within the same calendar day.
        // ------------------------------------------------------------------
        if (isAlreadyUploadedToday(cleanUrl, "", isSeriesSeason ? seasonNumber : null)) {
          logger.info(`Declining request: Already uploaded today -> ${cleanUrl} (Series: ${isSeriesSeason})`);
          await waSocket.sendMessage(replyTarget, {
            text:
`📁 *FILMFEED ARCHIVE • ALREADY UPLOADED TODAY*
━━━━━━━━━━━━━━━━━━━━
📌 *Status:* Available in Group
🎬 *Release:* ${isSeriesSeason ? `TV Series (Season ${seasonNumber})` : "Movie"}

💡 *Instant Access:*
This title has already been released to the official group today!
Please check the group media / documents list to download it immediately without waiting in queue. Duplicate uploads on the same day are declined to protect group storage.
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // ------------------------------------------------------------------
        // Check 3: User Spam Ban (5 Hours)
        // If the same user requests the exact same movie twice, ban them for 5 hours.
        // ------------------------------------------------------------------
        const userHasRequestedBefore =
          !isAdmin && (
            (userRecord.requestedUrls && userRecord.requestedUrls.includes(cleanUrl)) ||
            requestQueue.some((item) => item.cleanUrl === cleanUrl && item.senderPhone === senderPhone) ||
            (currentProcessingItem && currentProcessingItem.cleanUrl === cleanUrl && currentProcessingItem.senderPhone === senderPhone)
          );

        if (userHasRequestedBefore) {
          userRecord.isBanned = true;
          userRecord.banExpires = Date.now() + (5 * 60 * 60 * 1000); // 5 hours from now
          saveUserStats(stats);
          logger.warn(`🚫 User ${senderPhone} (${pushName}) banned for 5 hours for duplicate request: ${cleanUrl}`);
          await waSocket.sendMessage(replyTarget, {
            text:
`🚫 *FILMFEED SECURITY • 5-HOUR SPAM BAN*
━━━━━━━━━━━━━━━━━━━━
👤 *Member:* ${pushName} (+${senderPhone})
⏳ *Duration:* 5 Hours Lockout
⚠️ *Violation:* Duplicate request for the same title detected.

To prevent queue congestion and bot overload, requesting the exact same release twice is strictly prohibited. Your account access has been temporarily suspended for 5 hours.
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed Security Enforcement*`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // ------------------------------------------------------------------
        // Check 4: Check if already queued or actively downloading for another user
        // ------------------------------------------------------------------
        const isAlreadyQueuedOrActive =
          (currentProcessingItem && currentProcessingItem.cleanUrl === cleanUrl) ||
          requestQueue.some((item) => item.cleanUrl === cleanUrl);

        if (isAlreadyQueuedOrActive) {
          await waSocket.sendMessage(replyTarget, {
            text:
`⏳ *FILMFEED CINEMA • PROCESSING QUEUE*
━━━━━━━━━━━━━━━━━━━━
📌 *Notice:* This title is currently being prepared for the group.
⚡ *Status:* In Queue / Downloading

The release will be broadcast directly to your group once ready. No additional request is needed!
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // Record URL in user's requested list for duplicate spam prevention
        if (!userRecord.requestedUrls) {
          userRecord.requestedUrls = [];
        }
        if (!userRecord.requestedUrls.includes(cleanUrl)) {
          userRecord.requestedUrls.push(cleanUrl);
          saveUserStats(stats);
        }

        // ------------------------------------------------------------------
        // Check 5: Daily Limit Check for Non-VIP (6 movies per day)
        // ------------------------------------------------------------------
        const isVipUser = Boolean(isAdmin || userRecord.isVip);
        if (!isVipUser && userRecord.dailyCount >= 6) {
          logger.info(`User ${senderPhone} reached daily limit of 6 movies.`);
          const limitMessage =
`⚠️ *FILMFEED CINEMA • DAILY LIMIT REACHED*
━━━━━━━━━━━━━━━━━━━━
👤 *Member:* ${pushName} (${mentionTag})
📊 *Usage:* 6 / 6 Daily Requests Used

⏳ *Reset Time:* Midnight 12:00 AM
👑 *Upgrade:* Access unlimited high-speed requests with VIP.
👉 https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`;

          await waSocket.sendMessage(replyTarget, {
            text: limitMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // Check Group Membership
        let userGroups = [];
        if (isAdmin || isGroup) {
          userGroups = [{ jid: (isGroup ? remoteJid : TARGET_GROUP_JID), subject: "FilmFeed Cinema Group" }];
        } else {
          userGroups = await checkUserGroups(waSocket, cleanPhone, requesterJid, requesterLid, false);
        }

        const userStats = incrementUserRequest(senderPhone, pushName);
        const { count, badge } = userStats;

        const taskItem = {
          isSeriesSeason,
          seasonNumber,
          movieUrl,
          cleanUrl,
          quality,
          token,
          replyTarget,
          senderPhone,
          requesterJid: requesterJid || (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : ""),
          requesterLid: requesterLid || "",
          cleanPhone: cleanPhone || "",
          pushName,
          mentionTag,
          mentionDisplay,
          mentionsList,
          userStats,
          targetGroups: userGroups.map((g) => g.jid),
          createdAt: Date.now(),
        };

        if (userGroups.length === 0) {
          const pendingKey = cleanPhone || requesterLid || senderPhone;
          pendingGroupRequests.set(pendingKey, { taskItem, createdAt: Date.now() });

          const inviteLinks = [];
          for (const jid of TARGET_GROUP_JIDS) {
            const link = await getGroupInviteLink(waSocket, jid);
            const meta = await getCachedGroupMetadata(waSocket, jid);
            inviteLinks.push({ title: meta?.subject || "FilmFeed Cinema Group", link });
          }
          const linksText = inviteLinks
            .filter((x) => x.link)
            .map((x) => `🔗 *${x.title}:*\n👉 ${x.link}`)
            .join("\n\n");

          const joinRequiredMessage =
`⚠️ *FILMFEED CINEMA • MEMBERSHIP REQUIRED*
━━━━━━━━━━━━━━━━━━━━
👤 *Member:* ${pushName}
📌 *Notice:* Movies and TV series are dispatched exclusively to verified community groups.

Please join our official group to access downloads:
${linksText || "👉 Admin: +94 76 037 2547"}

━━━━━━━━━━━━━━━━━━━━
✅ *Verification:* Once joined, reply *done* in this chat to proceed! 🍿`;

          await waSocket.sendMessage(replyTarget, {
            text: joinRequiredMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // Add to queue
        requestQueue.push(taskItem);
        const queuePosition = requestQueue.length + (isProcessingQueue ? 1 : 0);

        if (isProcessingQueue) {
          logger.info(`Task added to queue at #${queuePosition} for ${pushName}`);
          const queueMessage =
`⏳ *FILMFEED CINEMA • QUEUE POSITION #${queuePosition}*
━━━━━━━━━━━━━━━━━━━━
👤 *Requester:* ${pushName} (${mentionTag}) [${badge}]
📦 *Release:* ${isSeriesSeason ? `TV Series (Season ${seasonNumber}) Pack` : "Feature Film"}
🌟 *Format:* ${quality} • Sinhala Subtitles
🔑 *Token:* ${token || "DIRECT"}

⚡ *Queue Status:* Position #${queuePosition}
━━━━━━━━━━━━━━━━━━━━
_Your request is scheduled and will automatically broadcast upon worker availability._`;

          await waSocket.sendMessage(replyTarget, {
            text: queueMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
        } else {
          const startMessage =
`🚀 *FILMFEED CINEMA • INITIALIZING DISPATCH*
━━━━━━━━━━━━━━━━━━━━
👤 *Requester:* ${pushName} (${mentionTag}) [${badge}]
📦 *Release:* ${isSeriesSeason ? `TV Series (Season ${seasonNumber}) Pack` : "Feature Film"}
🌟 *Format:* ${quality} • High-Speed Stream
🔑 *Token:* ${token || "DIRECT"}

⚡ *Status:* Secure resolver active. Starting download...
━━━━━━━━━━━━━━━━━━━━
🎬 *FilmFeed 4K Cinema Engine*`;

          await waSocket.sendMessage(replyTarget, {
            text: startMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
        }

        triggerQueue();
      } catch (msgErr) {
        logger.error({ msgErr }, "Error handling incoming WhatsApp message item");
      }
    }
  });
}

// --------------------------------------------------------------------------
// Master Bot Initialization (Single Continuous 24/7 Controller)
// --------------------------------------------------------------------------
async function startBot() {
  console.log("\n============================================================");
  console.log("🚀 STARTING FILMFEED MASTER BOT (0760372547) - 24/7 ONLINE");
  console.log("🎬 Movies + TV Series Engine (Single Master Controller)");
  console.log("============================================================\n");

  const sessionManager = new CloudSession(
    AUTH_DIR,
    process.env.GH_PAT || process.env.GITHUB_TOKEN,
    process.env.SESSION_VAULT_ID || "8f37b6dbcf07ff6fab07b21cc8cbe05b",
    "filmfeed-whatsapp-auth-vault-v1"
  );
  let restored = await sessionManager.restore();
  if (!restored && process.env.RESET_BOT !== "true") {
    console.log("⚠️ Initial restore attempt did not complete. Retrying restore in 2s...");
    await new Promise((r) => setTimeout(r, 2000));
    restored = await sessionManager.restore();
  }

  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Starting Baileys v${version.join(".")} (Latest: ${isLatest})`);

  let reconnectAttempts = 0;

  async function initSocket() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      version,
      logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "warn" })),
      },
      generateHighQualityLinkPreview: false,
      browser: Browsers.ubuntu("Chrome"),
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 120000,
      getMessage: async () => undefined,
    });

    waSocket = sock;

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      sessionManager.scheduleSync();
    });

    let lastSeenQR = "";
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && qr !== lastSeenQR) {
        lastSeenQR = qr;
        latestQR = qr;
        console.log("\n============================================================");
        console.log("📱 [FilmFeed Master Bot (0760372547)] SCAN QR CODE WITH WHATSAPP:");
        console.log("👉 WhatsApp on 0760372547 -> Linked Devices -> Link a Device");
        console.log("============================================================\n");
        qrcode.generate(qr, { small: true });
        console.log("\n============================================================\n");
      }

      if (connection === "open") {
        console.log("\n============================================================");
        console.log("✅ FILMFEED MASTER BOT (0760372547) CONNECTED SUCCESSFULLY!");
        console.log("🎬 Movies & TV Series 24/7 Engine Active");
        console.log("============================================================\n");
        isConnected = true;
        latestQR = null;
        reconnectAttempts = 0;
        await sessionManager.sync();

        triggerQueue();
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        console.warn(`[Master Bot] Connection closed (code: ${statusCode}). Reconnecting: ${!isLoggedOut}`);

        if (isLoggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          await sessionManager.clearVault();
          console.log("[Master Bot] Logged out. Restarting for fresh QR in 5s...");
          setTimeout(initSocket, 5000);
        } else {
          reconnectAttempts++;
          const delay = Math.min(30000, 2000 * reconnectAttempts);
          console.log(`[Master Bot] Reconnecting socket in ${delay / 1000}s (attempt #${reconnectAttempts})...`);
          setTimeout(initSocket, delay);
        }
      }
    });

    attachMessageEvents(sock);

    if (state.creds.registered) {
      console.log("[Master Bot] Existing session found in vault; connecting...");
    }
  }

  await initSocket();

  // Periodic vault sync every 15 minutes
  setInterval(async () => {
    if (isConnected) {
      try {
        await sessionManager.sync();
      } catch (_) {}
    }
  }, 15 * 60 * 1000);

  // 4.5 Hours Graceful Runner Rotation (prevents hard kills by GitHub Actions)
  const RUNNER_LIFETIME_HOURS = parseFloat(process.env.RUNNER_LIFETIME_HOURS || "4.5");
  if (RUNNER_LIFETIME_HOURS > 0) {
    const lifetimeMs = RUNNER_LIFETIME_HOURS * 60 * 60 * 1000;
    setTimeout(async () => {
      console.log(`⏰ [Rotation] Scheduled ${RUNNER_LIFETIME_HOURS}h runner rotation. Syncing vault...`);
      try {
        await sessionManager.sync();
      } catch (_) {}
      console.log("👋 Exiting cleanly for next continuous runner.");
      process.exit(0);
    }, lifetimeMs);
  }
}

startBot().catch((err) => logger.error({ err }, "Bot startup failed"));
