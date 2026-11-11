require("dotenv").config();
const path = require("path");
const fs = require("fs");

// Ensure Baileys messages-media.js is fully patched before Baileys is imported
try {
  const patchBaileys = require(path.join(__dirname, "../patch_baileys.js"));
  if (typeof patchBaileys === "function") patchBaileys();
} catch (_) {}

const dns = require("dns");
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}
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
const https = require("https");
const { execFile, execFileSync } = require("child_process");
const axios = require("axios");

// Force exact Content-Length on all media stream uploads to WhatsApp MMS (strictly required by WhatsApp servers)
function attachAxiosInterceptor(axInstance) {
  if (!axInstance || !axInstance.interceptors || !axInstance.interceptors.request) return;
  axInstance.interceptors.request.use((config) => {
    try {
      if (config.data && typeof config.data.pipe === "function" && config.data.path) {
        if (fs.existsSync(config.data.path)) {
          const stats = fs.statSync(config.data.path);
          if (config.headers && typeof config.headers.set === "function") {
            config.headers.set("Content-Length", String(stats.size));
          } else if (config.headers) {
            config.headers["Content-Length"] = String(stats.size);
          }
        }
      }
    } catch (_) {}
    return config;
  });
}
attachAxiosInterceptor(axios);
import("axios").then((esm) => {
  if (esm && esm.default) attachAxiosInterceptor(esm.default);
}).catch(() => {});
const CloudSession = require("./cloud_session");
const { broadcastDailyNews } = require("./daily_news");
const { registerBotInFirestore } = require("./firebase_sync");

const PORT = process.env.PORT || 7860;
const BOT_PHONE = process.env.BOT_PHONE || "94782088603";
const TARGET_GROUP_JIDS = (process.env.TARGET_GROUP_JIDS || "120363419930344447@g.us,120363428509877949@g.us")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGET_GROUP_JID = TARGET_GROUP_JIDS[0];
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "../auth_info");
const cloudSession = new CloudSession(
  AUTH_DIR,
  process.env.GH_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  process.env.SESSION_VAULT_ID || "8f37b6dbcf07ff6fab07b21cc8cbe05b"
);
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

function checkAndResetDaily(userRecord) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (userRecord.dailyDate !== todayStr) {
    userRecord.dailyDate = todayStr;
    userRecord.dailyCount = 0;
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
  let badge = "🌟 New Member";
  if (count >= 20) badge = "👑 Film Legend (VIP)";
  else if (count >= 10) badge = "🥇 Elite Cinephile";
  else if (count >= 5) badge = "🥈 Pro Movie Buff";
  else if (count >= 2) badge = "🥉 Regular Member";
  else badge = "✨ First Request (Welcome!)";

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
  return new Promise((resolve) => {
    const resolverScript = path.join(__dirname, "../resolver.py");
    const args = [movieUrl];
    if (quality) {
      args.push("--quality", quality);
    }

    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, ...args], { maxBuffer: 15 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Resolver script error");
        return resolve({ success: false, error: (stderr || err.message || "Resolver process error").slice(0, 300) });
      }
      try {
        const jsonMatch = (stdout || "").match(/\{[\s\S]*\}/);
        const data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse resolver JSON");
        resolve({ success: false, error: "Failed to parse resolver response" });
      }
    });
  });
}

async function resolveSeriesEpisodes(seriesUrl) {
  return new Promise((resolve) => {
    const resolverScript = path.join(__dirname, "../resolver.py");
    const args = [seriesUrl, "--episodes"];

    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, ...args], { maxBuffer: 15 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Series episodes resolver error");
        return resolve({ success: false, episodes: [], error: (stderr || err.message).slice(0, 300) });
      }
      try {
        const jsonMatch = (stdout || "").match(/\{[\s\S]*\}/);
        const data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse series episodes JSON");
        resolve({ success: false, episodes: [], error: "Failed to parse series episodes JSON" });
      }
    });
  });
}

async function resolveAnimeEpisodes(animeSlug) {
  return new Promise((resolve) => {
    const resolverScript = path.join(__dirname, "../anime_resolver.py");
    const args = ["--episodes", animeSlug];

    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, ...args], { maxBuffer: 15 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Anime episodes resolver error");
        return resolve({ success: false, episodes: [], error: (stderr || err.message).slice(0, 300) });
      }
      try {
        const jsonMatch = (stdout || "").match(/\{[\s\S]*\}/);
        const data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse anime episodes JSON");
        resolve({ success: false, episodes: [], error: "Failed to parse anime episodes JSON" });
      }
    });
  });
}

async function resolveAnimeEpisodeMp4(epSlug, quality = "720p") {
  return new Promise((resolve) => {
    const resolverScript = path.join(__dirname, "../anime_resolver.py");
    const args = ["--resolve", epSlug, "--quality", quality];

    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, ...args], { maxBuffer: 15 * 1024 * 1024, timeout: 45000 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Anime episode MP4 resolver error");
        return resolve({ success: false, error: (stderr || err.message).slice(0, 300) });
      }
      try {
        const jsonMatch = (stdout || "").match(/\{[\s\S]*\}/);
        const data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse anime episode MP4 JSON");
        resolve({ success: false, error: "Failed to parse anime episode MP4 JSON" });
      }
    });
  });
}

async function searchAnimeDirect(query) {
  return new Promise((resolve) => {
    const resolverScript = path.join(__dirname, "../anime_resolver.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, "--search", query], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const jsonMatch = (stdout || "").match(/\[[\s\S]*\]/);
        const data = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(stdout);
        resolve(data);
      } catch (_) {
        resolve([]);
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
      .replace(/\b(1080p|720p|480p|360p|2160p|4k|web-dl|bluray|hdrip|dvdrip|x264|x265|hevc|aac)\b/gi, " ")
      .replace(/[-_.]+/g, " ")
      .trim();

    const yMatch = title.match(/\b(19\d\d|20\d\d)\b/);
    const searchYear = year || (yMatch ? yMatch[1] : null);
    clean = clean.replace(/\b(19\d\d|20\d\d)\b/g, "").trim();

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
        timeout: 12000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://cinesubz.lk/",
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      if (pRes.data && pRes.data.length > 500) {
        fs.writeFileSync(tempInPath, Buffer.from(pRes.data));
      } else {
        return null;
      }
    } else if (Buffer.isBuffer(posterSource)) {
      fs.writeFileSync(tempInPath, posterSource);
    } else if (typeof posterSource === "string" && fs.existsSync(posterSource)) {
      fs.copyFileSync(posterSource, tempInPath);
    } else {
      return null;
    }

    await new Promise((resolve, reject) => {
      const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [POSTER_STYLER_SCRIPT, "thumb", tempInPath, tempOutPath], (err) => {
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
  backdropSource = null,
  title = null,
  year = null,
  rating = null,
  quality = null
) {
  if (!posterSource || !waSocket) {
    return posterSource;
  }

  const timestamp = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const tempPosterPath = path.join(TEMP_DIR, `poster_raw_${timestamp}.jpg`);
  const tempBackdropPath = path.join(TEMP_DIR, `backdrop_raw_${timestamp}.jpg`);
  const tempOutPath = path.join(TEMP_DIR, `branded_poster_${timestamp}.jpg`);

  try {
    // 1. Fetch or copy poster source
    if (typeof posterSource === "string" && posterSource.startsWith("http")) {
      const pRes = await axios.get(posterSource, {
        responseType: "arraybuffer",
        timeout: 12000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://cinesubz.lk/",
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      if (pRes.data && pRes.data.length > 500) {
        fs.writeFileSync(tempPosterPath, Buffer.from(pRes.data));
      } else {
        return posterSource;
      }
    } else if (Buffer.isBuffer(posterSource)) {
      fs.writeFileSync(tempPosterPath, posterSource);
    } else if (typeof posterSource === "string" && fs.existsSync(posterSource)) {
      fs.copyFileSync(posterSource, tempPosterPath);
    } else {
      return posterSource;
    }

    // Optional backdrop fetch (ignoring dummy placeholder zt_backdrop)
    let backdropArg = "NONE";
    const isCleanBackdrop = backdropSource &&
      typeof backdropSource === "string" &&
      !backdropSource.includes("zt_backdrop") &&
      !backdropSource.includes("no/zt_");

    if (isCleanBackdrop && backdropSource.startsWith("http")) {
      try {
        const bRes = await axios.get(backdropSource, {
          responseType: "arraybuffer",
          timeout: 10000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://cinesubz.lk/",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
        });
        if (bRes.data && bRes.data.length > 1000) {
          fs.writeFileSync(tempBackdropPath, Buffer.from(bRes.data));
          backdropArg = tempBackdropPath;
        }
      } catch (_) {}
    } else if (isCleanBackdrop && fs.existsSync(backdropSource)) {
      backdropArg = backdropSource;
    }

    const cleanName = (requesterName || "VIP Member").replace(/[\r\n\t]/g, " ").trim();
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const storyArg = storyline ? String(storyline).slice(0, 500) : "NONE";
    const titleArg = title ? String(title).slice(0, 100) : "NONE";
    const yearArg = year ? String(year).slice(0, 10) : "NONE";
    const ratingArg = rating ? String(rating).slice(0, 10) : "NONE";
    const qualityArg = quality ? String(quality).slice(0, 20) : "NONE";

    await new Promise((resolve, reject) => {
      execFile(
        pythonCmd,
        [
          POSTER_STYLER_SCRIPT,
          "brand",
          tempPosterPath,
          "NONE",
          cleanName,
          tempOutPath,
          storyArg,
          backdropArg,
          titleArg,
          yearArg,
          ratingArg,
          qualityArg,
        ],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    if (fs.existsSync(tempOutPath)) {
      const outputBuffer = fs.readFileSync(tempOutPath);
      logger.info(
        `[Poster Cinema Card] Luxury branded cinema poster created successfully: ${outputBuffer.length} bytes for ${title || cleanName}`
      );
      return outputBuffer;
    }
  } catch (err) {
    logger.warn(`[Poster Cinema Card] Branded poster styling failed: ${err.message}. Falling back to original.`);
  } finally {
    try { if (fs.existsSync(tempPosterPath)) fs.unlinkSync(tempPosterPath); } catch (_) {}
    try { if (fs.existsSync(tempBackdropPath)) fs.unlinkSync(tempBackdropPath); } catch (_) {}
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
  const fastDownloader = path.join(__dirname, "../fast_downloader.py");
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const { spawn } = require("child_process");

  const runDownloader = (threads, timeoutMs = 900000) => {
    return new Promise((resolve, reject) => {
      const child = spawn(pythonCmd, ["-u", fastDownloader, url, destPath, String(threads)], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      let buffer = "";
      let errBuffer = "";
      let lastActivity = Date.now();

      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) {}
        reject(new Error(`Downloader timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > 900000) {
          clearInterval(watchdog);
          clearTimeout(killTimer);
          try { child.kill("SIGKILL"); } catch (_) {}
          reject(new Error("Downloader stalled: no progress for 900s"));
        }
      }, 5000);

      const cleanupTimers = () => {
        clearTimeout(killTimer);
        clearInterval(watchdog);
      };

      child.stdout.on("data", (chunk) => {
        lastActivity = Date.now();
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
        lastActivity = Date.now();
        errBuffer += errData.toString();
        logger.warn(`[FastDownloader] ${errData.toString().trim()}`);
      });

      child.on("close", (code) => {
        cleanupTimers();
        if (code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 1000000) {
          resolve(destPath);
        } else {
          const detail = errBuffer.trim() || `Downloader exited with code ${code}`;
          reject(new Error(detail));
        }
      });

      child.on("error", (err) => {
        cleanupTimers();
        logger.error({ err }, "Failed spawning fast_downloader.py");
        reject(err);
      });
    });
  };

  try {
    return await runDownloader(8, 900000);
  } catch (err) {
    logger.warn(`4-thread parallel download failed (${err.message}). Retrying with 2-thread stream...`);
    try {
      return await runDownloader(2, 900000);
    } catch (retryErr) {
      logger.error(`Stream download also failed: ${retryErr.message}`);
      throw retryErr;
    }
  }
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

  const watchdogDuration = (currentTask?.isSeriesSeason || currentTask?.isAnimeSeason) ? 60 * 60 * 1000 : 20 * 60 * 1000;
  const queueWatchdog = setTimeout(() => {
    logger.warn(`[Queue Watchdog] Task ${currentTask?.movieUrl} exceeded timeout (${Math.round(watchdogDuration / 60000)}m)! Force releasing queue lock.`);
    isProcessingQueue = false;
    currentProcessingItem = null;
    if (requestQueue.length > 0) setTimeout(triggerQueue, 1000);
  }, watchdogDuration);

  const {
    isSeriesSeason,
    isAnimeSeason,
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
  try {
    cloudSession.updateGistFile("last_request.txt", `${new Date().toISOString()} | Processing: ${movieUrl} | By: ${pushName} | Q: ${quality}`);
  } catch (_) {}

  // Helper function to broadcast message to target groups with per-target timeout
  const broadcastToGroups = async (payload, timeoutMs = 180000) => {
    const isDocument = Boolean(payload && payload.document);
    // Broadcast to BOTH official FilmFeed groups (FilmFeed 1 & FilmFeed 2)
    const groupsToSend = (TARGET_GROUP_JIDS && TARGET_GROUP_JIDS.length > 0)
      ? TARGET_GROUP_JIDS
      : ["120363419930344447@g.us", "120363428509877949@g.us"];

    const effectiveTimeoutMs = isDocument ? Math.max(timeoutMs, 1800000) : timeoutMs;

    let sentCount = 0;
    let lastError = null;
    for (const jid of groupsToSend) {
      const maxAttempts = isDocument ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          logger.info(`[Broadcast] Sending to ${jid} (isDocument=${isDocument}, attempt=${attempt}/${maxAttempts})...`);
          const sendPromise = waSocket.sendMessage(jid, payload, { mediaUploadTimeoutMs: effectiveTimeoutMs });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${Math.round(effectiveTimeoutMs / 1000)}s) sending to ${jid}`)), effectiveTimeoutMs)
          );
          await Promise.race([sendPromise, timeoutPromise]);
          sentCount++;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          logger.error({ err, jid, attempt }, `Failed sending to group ${jid} on attempt ${attempt}: ${err.message}`);
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
    }
    if (sentCount === 0 && groupsToSend.length > 0) {
      throw lastError || new Error("WhatsApp message delivery failed to target groups");
    }
  };

  try {
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // MODE A.5: ANIME SEASON BATCH (Sequential Direct MP4 Delivery)
    // ----------------------------------------------------------------------
    if (isAnimeSeason) {
      let animeStatusKey = currentTask.statusMsgKey || null;
      if (animeStatusKey) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🚀 *[FilmFeed Anime Engine]*
━━━━━━━━━━━━━━━━━━━━
*${pushName}*, ඔබ ඉල්ලූ Anime Season Batch පැක් එක සැකසීම ආරම්භ විය!
⏳ *Status:* Resolving episodes & direct links...
━━━━━━━━━━━━━━━━━━━━`,
          edit: animeStatusKey,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      } else {
        try {
          const animeStatusMsg = await waSocket.sendMessage(replyTarget, {
            text: 
`🚀 *[FilmFeed Anime Engine]*
━━━━━━━━━━━━━━━━━━━━
*${pushName}*, ඔබ ඉල්ලූ Anime Season Batch පැක් එක සැකසීම ආරම්භ විය!
⏳ *Status:* Resolving episodes & direct links...
━━━━━━━━━━━━━━━━━━━━`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          animeStatusKey = animeStatusMsg?.key;
        } catch (_) {}
      }

      let animeSlug = movieUrl
        .replace(/https?:\/\/[^/]+\/(?:series\/)?/, "")
        .replace(/^\//, "")
        .split(/[?#|]/)[0]
        .replace(/\u00D7|×/g, " x ")
        .replace(/[*_]/g, " ")
        .replace(/[\u0D80-\u0DFF]+/g, "")
        .trim();

      if (!animeSlug || /anime\s*series\s*list/i.test(animeSlug)) {
        animeSlug = "solo-leveling";
      }

      // 1. First, search CineSubz for this Anime series
      let animeData = null;
      let episodes = [];
      try {
        const csSearch = await new Promise((res) => {
          const resolverScript = path.join(__dirname, "../resolver.py");
          const py = process.platform === "win32" ? "python" : "python3";
          execFile(py, [resolverScript, "--search", animeSlug], { timeout: 30000 }, (e, out) => {
            if (e) return res([]);
            try { res(JSON.parse(out)); } catch (_) { res([]); }
          });
        });
        if (csSearch && csSearch.length > 0) {
          const matchedSeries = csSearch.find((r) => r.is_series || (r.url && r.url.includes("tvshows"))) || csSearch[0];
          if (matchedSeries && matchedSeries.url) {
            const csEpData = await resolveSeriesEpisodes(matchedSeries.url);
            if (csEpData && csEpData.episodes && csEpData.episodes.length > 0) {
              animeData = csEpData;
              episodes = csEpData.episodes;
            }
          }
        }
      } catch (_) {}

      if (!animeData || episodes.length === 0) {
        animeData = await resolveAnimeEpisodes(animeSlug);
        episodes = animeData.episodes || [];
      }

      if (episodes.length === 0) {
        // Fallback: search by query
        const searchRes = await searchAnimeDirect(animeSlug);
        if (searchRes && searchRes.length > 0) {
          const matched = searchRes[0];
          const fallbackData = await resolveAnimeEpisodes(matched.slug || matched.title || animeSlug);
          if (fallbackData && fallbackData.episodes && fallbackData.episodes.length > 0) {
            episodes = fallbackData.episodes;
            animeData = fallbackData;
          }
        }
      }

      if (episodes.length === 0) {
        const failText = `❌ *[FilmFeed Anime]* Episodes not found for "${animeSlug}". Please verify the anime title and try again.`;
        if (animeStatusKey) {
          await waSocket.sendMessage(replyTarget, { text: failText, edit: animeStatusKey, contextInfo: getMetaAiContext(mentionsList) }).catch(() => {});
        } else {
          await waSocket.sendMessage(replyTarget, { text: failText, mentions: mentionsList, contextInfo: getMetaAiContext(mentionsList) });
        }
        return;
      }

      // Try TMDb for high-res backdrop & overview
      const tmdb = await getTmdbMediaDetails(animeData.title || animeSlug, true);
      const showTitle = tmdb?.title || animeData.title || animeSlug.replace(/-/g, " ").toUpperCase();
      const posterUrl = animeData.poster || tmdb?.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800";
      const backdropUrl = (tmdb?.backdrop && !tmdb.backdrop.includes("zt_backdrop"))
        ? tmdb.backdrop
        : (animeData.backdrop && !animeData.backdrop.includes("zt_backdrop")
          ? animeData.backdrop
          : posterUrl);
      const overview = tmdb?.overview || "FilmFeed Cinema Official Anime Batch Release";
      const totalEpisodes = episodes.length;

      // Broadcast Anime Season Poster Card to WhatsApp Groups IMMEDIATELY!
      const seasonCaption = 
`🎬 *${showTitle}*
━━━━━━━━━━━━━━━━━━━━
📦 *Pack Type:* Complete Anime Season Batch
🔢 *Total Episodes:* ${totalEpisodes} Episodes
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
🌟 *Quality:* ${quality || "720p HD"}
${tmdb?.voteAverage ? `⭐ *TMDb Rating:* ${tmdb.voteAverage.toFixed(1)}/10\n` : ""}${tmdb?.releaseDate ? `📅 *Air Date:* ${tmdb.releaseDate}\n` : ""}🔑 *Token:* ${token || "VIP_ANIME"}
⚡ *Audio / Sub:* Sinhala / English Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📝 *Storyline / සාරාංශය:*
${overview.length > 350 ? overview.substring(0, 350) + "..." : overview}

📥 _Episode 1 සිට ${totalEpisodes} දක්වා පිළිවෙළින් Group එකට Upload වනු ඇත!_\n${getPromoFooter()}`;

      try {
        const effectivePoster = posterUrl || backdropUrl;
        if (effectivePoster) {
          const pipPoster = await createPosterWithRequesterAvatar(
            effectivePoster,
            requesterIdentifier,
            fallbackIdentifier,
            pushName,
            overview,
            backdropUrl,
            showTitle,
            tmdb?.releaseDate ? String(tmdb.releaseDate).slice(0, 4) : "2024",
            tmdb?.voteAverage ? `${tmdb.voteAverage.toFixed(1)}/10` : "8.5/10",
            quality || "720p"
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
        logger.info(`✅ Instant Anime Season poster broadcasted to group for ${showTitle}`);
      } catch (posterErr) {
        logger.error({ posterErr }, `Failed to broadcast anime poster: ${posterErr.message}`);
      }

      // Download and Upload each episode 1 by 1
      let animeUploadedCount = 0;
      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        const epIndex = ep.episode || (i + 1);
        logger.info(`[Anime Engine] Resolving episode ${epIndex}/${totalEpisodes}: ${ep.slug || ep.url}`);

        if (animeStatusKey) {
          await waSocket.sendMessage(replyTarget, {
            text: 
`🎬 *[FilmFeed Anime Engine]*
━━━━━━━━━━━━━━━━━━━━
📌 *Anime:* *${showTitle}*
🔢 *Progress:* Episode ${epIndex} of ${totalEpisodes}
⏳ *Status:* Downloading episode...
━━━━━━━━━━━━━━━━━━━━`,
            edit: animeStatusKey,
            contextInfo: getMetaAiContext(mentionsList),
          }).catch(() => {});
        }

        try {
          let directUrl = null;
          let resolvedQuality = quality || "720p";

          if (ep.url && ep.url.includes("cinesubz")) {
            const epData = await resolveMovie(ep.url, quality || "720p");
            if (epData && epData.direct_url) {
              directUrl = epData.direct_url;
              resolvedQuality = epData.quality || resolvedQuality;
            }
          }

          if (!directUrl && ep.slug) {
            const epData = await resolveAnimeEpisodeMp4(ep.slug, quality || "720p");
            if (epData && epData.direct_link) {
              directUrl = epData.direct_link;
              resolvedQuality = epData.quality || resolvedQuality;
            }
          }

          if (!directUrl) {
            logger.warn(`Skipping anime episode ${epIndex}: No direct download link found.`);
            continue;
          }

          const safeName = `${showTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_E${epIndex}_${resolvedQuality}.mp4`;
          const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);

          await downloadFile(directUrl, tempFilePath);

          if (!fs.existsSync(tempFilePath) || fs.statSync(tempFilePath).size < 1000000) {
            logger.warn(`Anime episode ${epIndex} download failed or <1MB. Skipping.`);
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            continue;
          }

          if (animeStatusKey) {
            await waSocket.sendMessage(replyTarget, {
              text: 
`🎬 *[FilmFeed Anime Engine]*
━━━━━━━━━━━━━━━━━━━━
📌 *Anime:* *${showTitle}*
🔢 *Progress:* Episode ${epIndex} of ${totalEpisodes}
📤 *Status:* Uploading to WhatsApp group...
━━━━━━━━━━━━━━━━━━━━`,
              edit: animeStatusKey,
              contextInfo: getMetaAiContext(mentionsList),
            }).catch(() => {});
          }

          // Upload Episode Document to All Target Groups
          await broadcastToGroups({
            document: { url: tempFilePath },
            mimetype: "video/mp4",
            fileName: `${showTitle} - Episode ${epIndex} (${resolvedQuality}).mp4`,
            caption: `🎬 *${showTitle} - Episode ${epIndex}*\n🔢 Episode ${epIndex} of ${totalEpisodes}\n⚡ Quality: ${resolvedQuality}\n🍿 *FilmFeed Anime Engine*\n${getPromoFooter()}`,
          });

          logger.info(`✅ Anime Episode ${epIndex}/${totalEpisodes} uploaded successfully to groups!`);
          animeUploadedCount++;

          // Cleanup temp file
          try {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          } catch (_) {}

          // Brief pause between episodes
          await new Promise((r) => setTimeout(r, 2000));
        } catch (epErr) {
          logger.error({ epErr }, `Error processing anime episode ${epIndex}: ${epErr.message}`);
        }
      }

      // Final English notification edited in place on the single status message
      if (animeStatusKey && replyTarget && !replyTarget.endsWith("@g.us")) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *FilmFeed Anime Engine*
━━━━━━━━━━━━━━━━━━━━
✨ *Anime Pack Successfully Uploaded!*

🍿 *Anime:* *${showTitle}*
📦 *Episodes:* ${animeUploadedCount}/${totalEpisodes} Completed
👤 *Requested By:* ${pushName} [${badge}]

✅ The anime episodes have been successfully uploaded to the official FilmFeed WhatsApp Group!

📥 *Download from the Group:*
👥 ${primaryGroupLink}

🌐 *Website:* https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━
🍿 Thank you for choosing FilmFeed!`,
          edit: animeStatusKey,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      }

      logger.info(`🎉 Complete Anime Season Batch delivery finished for ${showTitle}!`);
      return;
    }

    // MODE A: TV SERIES SEASON BATCH (Sequential Episode Delivery)
    // ----------------------------------------------------------------------
    if (isSeriesSeason) {
      let seriesStatusKey = currentTask.statusMsgKey || null;
      if (seriesStatusKey) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🚀 *[FilmFeed TV Series Engine]*
━━━━━━━━━━━━━━━━━━━━
*${pushName}*, ඔබ ඉල්ලූ Season ${seasonNumber} පැක් එක සැකසීම ආරම්භ විය!
⏳ *Status:* Resolving series episodes...
━━━━━━━━━━━━━━━━━━━━`,
          edit: seriesStatusKey,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      } else {
        try {
          const seriesStatusMsg = await waSocket.sendMessage(replyTarget, {
            text: 
`🚀 *[FilmFeed TV Series Engine]*
━━━━━━━━━━━━━━━━━━━━
*${pushName}*, ඔබ ඉල්ලූ Season ${seasonNumber} පැක් එක සැකසීම ආරම්භ විය!
⏳ *Status:* Resolving series episodes...
━━━━━━━━━━━━━━━━━━━━`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          seriesStatusKey = seriesStatusMsg?.key;
        } catch (_) {}
      }

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
        const failText = `❌ *[FilmFeed TV Series]* Season ${seasonNumber} සඳහා Episodes සොයාගත නොහැකි විය.`;
        if (seriesStatusKey) {
          await waSocket.sendMessage(replyTarget, { text: failText, edit: seriesStatusKey, contextInfo: getMetaAiContext(mentionsList) }).catch(() => {});
        } else {
          await waSocket.sendMessage(replyTarget, { text: failText, mentions: mentionsList, contextInfo: getMetaAiContext(mentionsList) });
        }
        return;
      }

      // High-res TMDb lookup for the TV series
      const tmdb = await getTmdbMediaDetails(seriesData.title || "TV Series", true);
      const showTitle = tmdb?.title || seriesData.title || "TV Series";
      const posterUrl = seriesData.poster || tmdb?.poster || seriesData.backdrop;
      const backdropUrl = (tmdb?.backdrop && !tmdb.backdrop.includes("zt_backdrop"))
        ? tmdb.backdrop
        : (seriesData.backdrop && !seriesData.backdrop.includes("zt_backdrop")
          ? seriesData.backdrop
          : posterUrl);
      const overview = tmdb?.overview || seriesData.description || "FilmFeed Cinema Series Release";
      const totalEpisodes = episodes.length;

      // Broadcast Season Poster Card to WhatsApp Groups IMMEDIATELY!
      const seasonCaption = 
`🎬 *${showTitle} (Season ${seasonNumber})*
━━━━━━━━━━━━━━━━━━━━
📦 *Pack Type:* Complete Season Batch
🔢 *Total Episodes:* ${totalEpisodes} Episodes
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
🌟 *Quality:* ${quality}
${tmdb?.voteAverage ? `⭐ *TMDb Rating:* ${tmdb.voteAverage.toFixed(1)}/10\n` : ""}${tmdb?.releaseDate ? `📅 *Air Date:* ${tmdb.releaseDate}\n` : ""}🔑 *Token:* ${token || "VIP_SEASON"}
⚡ *Subtitle:* Sinhala Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📝 *Storyline / සාරාංශය:*
${overview.length > 350 ? overview.substring(0, 350) + "..." : overview}

📥 _Episode 1 සිට ${totalEpisodes} දක්වා පිළිවෙළින් Group එකට Upload වනු ඇත!_\n${getPromoFooter()}`;

      const effectivePoster = posterUrl || backdropUrl;
      try {
        if (effectivePoster) {
          const pipPoster = await createPosterWithRequesterAvatar(
            effectivePoster,
            requesterIdentifier,
            fallbackIdentifier,
            pushName,
            overview,
            backdropUrl,
            showTitle,
            tmdb?.releaseDate ? String(tmdb.releaseDate).slice(0, 4) : "2024",
            tmdb?.voteAverage ? `${tmdb.voteAverage.toFixed(1)}/10` : "8.5/10",
            quality
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
        logger.info(`✅ Instant TV Series Season poster broadcasted to group for ${showTitle}`);
      } catch (posterErr) {
        logger.error({ posterErr }, `Failed to broadcast series poster: ${posterErr.message}`);
      }

      // Download and Upload each episode 1 by 1
      let uploadedCount = 0;
      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        const epIndex = i + 1;
        logger.info(`Resolving and downloading episode ${epIndex}/${totalEpisodes}: ${ep.title} (${ep.url})`);

        if (seriesStatusKey) {
          await waSocket.sendMessage(replyTarget, {
            text: 
`🎬 *[FilmFeed TV Series Engine]*
━━━━━━━━━━━━━━━━━━━━
📌 *Series:* *${showTitle}* (Season ${seasonNumber})
🔢 *Progress:* Episode ${epIndex} of ${totalEpisodes}
⏳ *Status:* Downloading episode...
━━━━━━━━━━━━━━━━━━━━`,
            edit: seriesStatusKey,
            contextInfo: getMetaAiContext(mentionsList),
          }).catch(() => {});
        }

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

          if (seriesStatusKey) {
            await waSocket.sendMessage(replyTarget, {
              text: 
`🎬 *[FilmFeed TV Series Engine]*
━━━━━━━━━━━━━━━━━━━━
📌 *Series:* *${showTitle}* (Season ${seasonNumber})
🔢 *Progress:* Episode ${epIndex} of ${totalEpisodes}
📤 *Status:* Uploading to WhatsApp group...
━━━━━━━━━━━━━━━━━━━━`,
              edit: seriesStatusKey,
              contextInfo: getMetaAiContext(mentionsList),
            }).catch(() => {});
          }

          // Upload Episode Document to All Target Groups with fallback
          const epThumbnail = await getPosterThumbnail(posterUrl || epData.poster || epData.backdrop, epData.thumbnail_b64);
          let epUploadSucceeded = false;
          try {
            await broadcastToGroups({
              document: { url: tempFilePath },
              mimetype: "video/mp4",
              fileName: `${epTitle} [${resolvedQuality}] [FilmFeed].mp4`,
              caption: 
`🎬 *${epTitle}* (${resolvedQuality})
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
📦 *Season:* Season ${seasonNumber} [Episode ${epIndex}/${totalEpisodes}]
⚡ *Status:* Uploaded Successfully
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed TV Series Engine
${getPromoFooter()}`,
              mentions: mentionsList,
              ...(epThumbnail ? { jpegThumbnail: epThumbnail } : {}),
              contextInfo: getMetaAiContext(mentionsList),
            }, 120000);
            epUploadSucceeded = true;
          } catch (uploadErr) {
            logger.warn(`Episode ${epIndex} document upload timed out or failed (${uploadErr.message}). Broadcasting direct link fallback...`);
            await broadcastToGroups({
              text: 
`🎬 *${epTitle}* (${resolvedQuality})
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
📦 *Season:* Season ${seasonNumber} [Episode ${epIndex}/${totalEpisodes}]
⚡ *High-Speed Direct Download:*
WhatsApp Server සීමාව නිසා, පහත Direct High-Speed ලින්ක් එකෙන් (100MB/s) දැන්ම බාගත කරගන්න:

🚀 *Direct Download Link:*
🔗 ${directUrl}
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed TV Series Engine
${getPromoFooter()}`,
              mentions: mentionsList,
              contextInfo: getMetaAiContext(mentionsList),
            });
            epUploadSucceeded = true;
          }

          uploadedCount++;

          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }

          await new Promise((r) => setTimeout(r, 1500));
        } catch (epErr) {
          logger.error({ epErr }, `Error processing episode ${epIndex}`);
        }
      }

      if (uploadedCount === 0) {
        logger.warn(`No episodes were successfully uploaded for ${showTitle} Season ${seasonNumber}.`);
        const failMsg = `❌ *[FilmFeed TV Series]* Season ${seasonNumber} හි කිසිදු Episode එකක් බාගත කිරීමට හෝ Upload කිරීමට නොහැකි විය.`;
        if (seriesStatusKey) {
          await waSocket.sendMessage(replyTarget, { text: failMsg, edit: seriesStatusKey, contextInfo: getMetaAiContext(mentionsList) }).catch(() => {});
        } else {
          await waSocket.sendMessage(replyTarget, { text: failMsg, mentions: mentionsList, contextInfo: getMetaAiContext(mentionsList) });
        }
        return;
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

      // Final Season Completion Notification edited in place on the single status message
      if (seriesStatusKey && replyTarget && !replyTarget.endsWith("@g.us")) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *FilmFeed TV Series Engine*
━━━━━━━━━━━━━━━━━━━━
✨ *Series Pack Successfully Uploaded!*

📺 *Series:* *${showTitle}* (Season ${seasonNumber})
📦 *Episodes:* ${uploadedCount}/${totalEpisodes} Completed
👤 *Requested By:* ${pushName} [${badge}]

✅ All requested episodes have been successfully uploaded to the official FilmFeed WhatsApp Group!

📥 *Download from the Group:*
👥 ${primaryGroupLink}

🌐 *Website:* https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━
🍿 Enjoy your TV series!`,
          edit: seriesStatusKey,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      }

    } else {
      // ----------------------------------------------------------------------
      // MODE B: SINGLE MOVIE PROCESSING (Single Progressive Editable DM Message)
      // ----------------------------------------------------------------------
      let liveStatusMsg = currentTask.statusMsgKey ? { key: currentTask.statusMsgKey } : null;
      if (liveStatusMsg?.key) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *[FilmFeed Cinema Engine]*
━━━━━━━━━━━━━━━━━━━━
👋 Hello *${pushName}*, your request is being processed!
⏳ *Status:* Initializing download stream...

📺 *Quality:* ${quality}
🔑 *Token:* #${token || "DIRECT"}
━━━━━━━━━━━━━━━━━━━━`,
          edit: liveStatusMsg.key,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      } else {
        liveStatusMsg = await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *[FilmFeed Cinema Engine]*
━━━━━━━━━━━━━━━━━━━━
👋 Hello *${pushName}*, your request is being processed!
⏳ *Status:* Initializing download stream...

📺 *Quality:* ${quality}
🔑 *Token:* #${token || "DIRECT"}
━━━━━━━━━━━━━━━━━━━━`,
          mentions: mentionsList,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => null);
      }

      const movieData = await resolveMovie(movieUrl, quality);

      if (!movieData.success || !movieData.direct_url) {
        const failText = `❌ *[FilmFeed Cinema Engine]* Error: ${movieData.error || "චිත්‍රපට ලින්ක් එක ලබා ගැනීමට නොහැකි විය."}`;
        if (liveStatusMsg?.key) {
          await waSocket.sendMessage(replyTarget, { text: failText, edit: liveStatusMsg.key, contextInfo: getMetaAiContext(mentionsList) }).catch(() => {});
        } else {
          await waSocket.sendMessage(replyTarget, { text: failText, mentions: mentionsList, contextInfo: getMetaAiContext(mentionsList) });
        }
        return;
      }

      // Query TMDb for metadata, but prioritize scraped poster from movie page
      const rawTitle = movieData.title || "Movie";
      const tmdb = await getTmdbMediaDetails(rawTitle, false);
      const title = tmdb?.title || rawTitle;
      const posterUrl = movieData.poster || tmdb?.poster || movieData.backdrop;
      const backdropUrl = (tmdb?.backdrop && !tmdb.backdrop.includes("zt_backdrop"))
        ? tmdb.backdrop
        : (movieData.backdrop && !movieData.backdrop.includes("zt_backdrop")
          ? movieData.backdrop
          : posterUrl);
      const overview = tmdb?.overview || movieData.description || "FilmFeed Cinema Direct Release";
      const directUrl = movieData.direct_url;
      const resolvedQuality = movieData.quality || quality;
      const releaseYear = tmdb?.releaseDate ? tmdb.releaseDate.substring(0, 4) : "";
      const ratingVal = tmdb?.voteAverage ? tmdb.voteAverage.toFixed(1) : "";

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
━━━━━━━━━━━━━━━━━━━━
ආයුබෝවන් *${pushName}*,
ඔබ ඉල්ලූ *${title}* (${resolvedQuality}) චිත්‍රපටයේ ගොනු ප්‍රමාණය: *${sizeInGB}* කි.

📌 *WhatsApp නීති රීති අනුව:*
WhatsApp මඟින් Document එකක් ලෙස එකවර යැවිය හැක්කේ උපරිම *1.95 GB* දක්වා ගොනු පමණි.

💡 *විසඳුම:*
කරුණාකර වෙබ් අඩවියෙන් *720p* හෝ *480p* Quality එක (2GB ට අඩු) තෝරා නැවත Request කරන්න:
👉 https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━`;

        if (liveStatusMsg?.key) {
          await waSocket.sendMessage(replyTarget, { text: sizeAlertMsg, edit: liveStatusMsg.key, contextInfo: getMetaAiContext(mentionsList) }).catch(() => {});
        } else {
          await waSocket.sendMessage(replyTarget, { text: sizeAlertMsg, mentions: mentionsList, contextInfo: getMetaAiContext(mentionsList) });
        }
        return;
      }

      // 1. Prepare High-Res Poster Card (Aesthetic Cinema Presentation)
      const effectivePoster = posterUrl || backdropUrl;
      const sizeTextDisplay = movieData.size_text || (actualBytes > 0 ? `${Math.round(actualBytes / (1024 * 1024))}MB` : resolvedQuality);

      const isVipRequester = Boolean(currentTask.isVip || (badge && (badge.includes("VIP") || badge.includes("👑"))));

      const groupPosterCaption = isVipRequester ?
`👑 *FILMFEED VIP PREMIERE* 👑
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎬 *${title}*
🌟 *Quality:* ${resolvedQuality} • *Size:* ${sizeTextDisplay}
${ratingVal ? `⭐ *Rating:* ${ratingVal}/10\n` : ""}${releaseYear ? `📅 *Year:* ${releaseYear}\n` : ""}👤 *VIP Member:* ${currentTask.mentionDisplay || mentionTag}
💎 *Pass:* Ultra VIP Priority Dispatch
⚡ *Audio / Sub:* Sinhala Subtitles Included (4K Master)
🔑 *VIP Token:* #${token || "VIP_EXCLUSIVE"}
━━━━━━━━━━━━━━━━━━━━━━━━━━
🍿 _VIP Movie document is broadcasting to the group now..._
${getPromoFooter()}`
:
`🎬 *FILMFEED CINEMA RELEASE* 🍿
━━━━━━━━━━━━━━━━━━━━
🔥 *${title}*
🌟 *Quality:* ${resolvedQuality} • *Size:* ${sizeTextDisplay}
${ratingVal ? `⭐ *Rating:* ${ratingVal}/10\n` : ""}${releaseYear ? `📅 *Year:* ${releaseYear}\n` : ""}👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *User Stats:* Request #${count} [${badge}]
⚡ *Audio / Sub:* Sinhala Subtitles Included
🔑 *Token:* #${token || "DIRECT"}
━━━━━━━━━━━━━━━━━━━━
🍿 _චිත්‍රපටය (Document එක) මේ දැන්ම සමූහය වෙත ලැබෙනු ඇත..._
${getPromoFooter()}`;

      let posterBroadcasted = false;
      const broadcastPosterCard = async () => {
        if (posterBroadcasted) return;
        posterBroadcasted = true;
        try {
          if (effectivePoster) {
            const pipPoster = await createPosterWithRequesterAvatar(
              effectivePoster,
              requesterIdentifier,
              fallbackIdentifier,
              pushName,
              overview,
              backdropUrl,
              title,
              releaseYear,
              ratingVal,
              resolvedQuality
            );
            await broadcastToGroups({
              image: Buffer.isBuffer(pipPoster) ? pipPoster : { url: effectivePoster },
              caption: groupPosterCaption,
              mentions: mentionsList,
              contextInfo: getMetaAiContext(mentionsList),
            });
          } else {
            await broadcastToGroups({
              text: groupPosterCaption,
              mentions: mentionsList,
              contextInfo: getMetaAiContext(mentionsList),
            });
          }
          logger.info(`✅ Movie poster card broadcasted to WhatsApp group for ${title}!`);
        } catch (posterErr) {
          logger.error({ posterErr }, `Failed to broadcast poster card: ${posterErr.message}`);
        }
      };

      // Update initial status to Downloading
      if (liveStatusMsg?.key) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *[FilmFeed Cinema Engine]*
━━━━━━━━━━━━━━━━━━━━
📌 *Movie:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
⏳ *Status:* Download started...
📥 *Progress:* 0%
⚡ *Server:* High-Speed Ultra Stream
━━━━━━━━━━━━━━━━━━━━`,
          edit: liveStatusMsg.key,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      }

      // 2. Download Movie File to Disk and Upload as WhatsApp Document
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
      let uploadSucceeded = false;
      let finalSizeMB = 0;

      try {
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
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *Movie:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
⏳ *Status:* Downloading (Telegram Stream)...
📥 *Progress:* ${percent}% (${dMB}MB / ${tMB}MB)
⚡ *Speed:* ${speedText}
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
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *Movie:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
⏳ *Status:* Downloading...
📥 *Progress:* ${percent}% (${dMB}MB / ${tMB}MB)
⚡ *Speed:* ${speedText}
━━━━━━━━━━━━━━━━━━━━`,
                  edit: liveStatusMsg.key,
                  contextInfo: getMetaAiContext(mentionsList),
                }).catch(() => {});
              }
            }
          });
        }

        // Verify file exists on disk and is > 1MB
        if (!fs.existsSync(tempFilePath)) {
          throw new Error("Video file download failed. File not created on disk.");
        }
        const finalFileSize = fs.statSync(tempFilePath).size;
        if (finalFileSize < 1000000) {
          throw new Error(`Download error: received file is only ${Math.round(finalFileSize / 1024)}KB.`);
        }

        finalSizeMB = Math.round(finalFileSize / (1024 * 1024));
        logger.info(`Download verified! Final file size on disk: ${finalSizeMB}MB.`);

        // Update Live Status Message: Uploading
        if (liveStatusMsg?.key) {
          await waSocket.sendMessage(replyTarget, {
            text: 
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *Movie:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
✅ *Download:* 100% Complete (${finalSizeMB}MB)
📤 *Status:* Uploading to WhatsApp group...
⚡ *Broadcast:* In progress
━━━━━━━━━━━━━━━━━━━━`,
            edit: liveStatusMsg.key,
            contextInfo: getMetaAiContext(mentionsList),
          }).catch(() => {});
        }

        // Refresh Media Connection to ensure valid, non-expired MMS upload token
        try {
          logger.info("Refreshing WhatsApp media connection credentials before upload...");
          await waSocket.refreshMediaConn(true);
        } catch (mConnErr) {
          logger.warn(`Could not force refreshMediaConn: ${mConnErr.message}`);
        }

        // Setup global progress hook to broadcast poster card at 50% upload
        global.__waMediaUploadProgress = async (progressEvent) => {
          const loaded = progressEvent.loaded || 0;
          const total = progressEvent.total || (finalFileSize || 1);
          const percent = Math.min(100, Math.round((loaded / total) * 100));

          // When upload reaches 50%, broadcast poster card to the WhatsApp group!
          if (percent >= 50 && !posterBroadcasted) {
            logger.info(`🚀 [Upload 50%] Milestone reached for ${title}! Broadcasting poster card to WhatsApp group...`);
            await broadcastPosterCard();
          }

          const now = Date.now();
          if (liveStatusMsg?.key && now - lastProgressEdit > 4000) {
            lastProgressEdit = now;
            const upMB = Math.round(loaded / (1024 * 1024));
            waSocket.sendMessage(replyTarget, {
              text: 
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *Movie:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
✅ *Download:* 100% Complete (${finalSizeMB}MB)
📤 *Uploading:* ${percent}% (${upMB}MB / ${finalSizeMB}MB)
⚡ *Status:* Group Broadcast in Progress
━━━━━━━━━━━━━━━━━━━━`,
              edit: liveStatusMsg.key,
              contextInfo: getMetaAiContext(mentionsList),
            }).catch(() => {});
          }
        };

        // Upload Document to all groups with Movie Poster Thumbnail & Meta AI Styling (streaming directly from disk)
        logger.info(`Uploading ${finalSizeMB}MB document to WhatsApp groups...`);
        const thumbBuffer = await getPosterThumbnail(posterUrl || effectivePoster, movieData?.thumbnail_b64);
        
        await broadcastToGroups({
          document: { url: tempFilePath },
          mimetype: "video/mp4",
          fileName: `${title.replace(/[\/\\?%*:|"<>]/g, "").trim()} [${resolvedQuality}] [FilmFeed].mp4`,
          caption: 
`🎬 *FILMFEED CINEMA MASTER* 🍿
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔥 *${title}*
🌟 *Format:* MP4 Document • *Quality:* ${resolvedQuality} (${finalSizeMB}MB)
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
💎 *Release:* Official Cinema Drop
⚡ *Subtitles:* Sinhala Subtitles Embedded
━━━━━━━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed 4K Ultra Engine
${getPromoFooter()}`,
          mentions: mentionsList,
          ...(thumbBuffer && thumbBuffer.length <= 32000 ? { jpegThumbnail: thumbBuffer } : {}),
          contextInfo: getMetaAiContext(mentionsList),
        }, 1800000);

        // Ensure poster was broadcasted if upload completed fast before 50% hook fired
        if (!posterBroadcasted) {
          await broadcastPosterCard();
        }
        uploadSucceeded = true;
      } catch (fileErr) {
        // In case of error, ensure group at least has poster if not yet broadcasted
        if (!posterBroadcasted) {
          await broadcastPosterCard().catch(() => {});
        }
        logger.error({ fileErr }, `Document download/upload encountered issue: ${fileErr.message}`);
        try {
          cloudSession.updateGistFile("last_error.txt", `${new Date().toISOString()} | Document Upload Error: ${fileErr.message}\n${fileErr.stack || ""}`);
        } catch (_) {}
// Fallback text broadcast removed - no text message in group on document error
        uploadSucceeded = true;
      }

      // Deliver final completion by editing liveStatusMsg in requester DM (English notification to download from group)
      if (liveStatusMsg?.key && replyTarget && !replyTarget.endsWith("@g.us")) {
        await waSocket.sendMessage(replyTarget, {
          text: 
`🎬 *FilmFeed Cinema Engine*
━━━━━━━━━━━━━━━━━━━━
✨ *Movie Successfully Uploaded!*

🍿 *Movie:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
📦 *File Size:* ${finalSizeMB}MB
⚡ *Status:* Group Broadcast Completed

✅ The movie has been successfully uploaded to the official FilmFeed WhatsApp Group!

📥 *Download from the Group:*
👥 ${primaryGroupLink}

🌐 *Website:* https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━
🍿 Enjoy your movie!`,
          edit: liveStatusMsg.key,
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
        dmCompleted = true;
      }

// 4.1. Movie Poll completely removed - NO message after document

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
      global.__waMediaUploadProgress = null;
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // 6. Record movie in user's history
      const updatedStats = incrementUserRequest(requesterJid || replyTarget, pushName, title, resolvedQuality);

      // Only send final summary if requested inside a group — NEVER to user DM
      if (replyTarget && replyTarget.endsWith("@g.us")) {
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
          contextInfo: getMetaAiContext(mentionsList),
        }).catch(() => {});
      }
    }

  } catch (err) {
    logger.error({ err }, "Error processing queued task");
    try {
      cloudSession.updateGistFile("last_error.txt", `${new Date().toISOString()} | Task Error: ${err.message}\n${err.stack || ""}`);
    } catch (_) {}

    if (dmCompleted && replyTarget && !replyTarget.endsWith("@g.us")) {
      logger.info(`Task already marked complete in requester DM ${replyTarget}. Suppressing further messages.`);
    } else if (typeof directUrl !== "undefined" && directUrl) {
      // Direct stream fallback for group or uncompleted task
      await waSocket.sendMessage(replyTarget, {
        text: `🎬 *${typeof title !== "undefined" ? title : "Movie"}* (${typeof resolvedQuality !== "undefined" ? resolvedQuality : "HD"})\n━━━━━━━━━━━━━━━━━━━━\n⚠️ Server Document Upload limit reached. Stream or download via high-speed direct link:\n\n🚀 *Direct Link (100MB/s):*\n🔗 ${directUrl}\n━━━━━━━━━━━━━━━━━━━━\n🍿 FilmFeed Cinema Engine`,
        contextInfo: getMetaAiContext(mentionsList),
      }).catch(() => {});
    } else {
      await waSocket.sendMessage(replyTarget, {
        text: `⚠️ *[FilmFeed Auto-Bot]* An error occurred: ${err.message}`,
        contextInfo: getMetaAiContext(mentionsList),
      }).catch(() => {});
    }
  } finally {
    if (typeof queueWatchdog !== "undefined" && queueWatchdog) {
      clearTimeout(queueWatchdog);
    }
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
const messageStore = new Map();

function attachMessageEvents(sock) {
  sock.ev.on("messages.upsert", async (m) => {
    // Only process new incoming messages — skip history sync replays on startup
    if (m.type !== "notify") return;
    if (!m.messages || m.messages.length === 0) return;

    for (const msg of m.messages) {
      if (msg.key?.id && msg.message) {
        messageStore.set(msg.key.id, msg.message);
        if (messageStore.size > 2000) {
          const oldest = messageStore.keys().next().value;
          messageStore.delete(oldest);
        }
      }
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

        // SILENCE CASUAL DM CHATS: If message is in personal DM and not an official command, IGNORE COMPLETELY!
        if (!remoteJid.endsWith("@g.us")) {
          const hasOfficialHeader = text.includes("FILMFEED 4K • OFFICIAL REQUEST") ||
                                     text.includes("FILMFEED VIP PREMIERE REQUEST") ||
                                     text.includes("FILMFEED");
          const hasCommandPrefix = /^[!/.](?:req|anime|done|verify)/i.test(text.trim());
          if (!hasOfficialHeader && !hasCommandPrefix) {
            continue;
          }
        }

        const isGroup = remoteJid.endsWith("@g.us");
        const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
        const pushName = msg.pushName || (fromMe ? "Admin" : "Member");

        const rawPhone = senderJid.split("@")[0].replace(/:\d+/, "");
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
        const requesterLid = (senderJid && senderJid.endsWith("@lid"))
          ? senderJid
          : (msg.key.participant && msg.key.participant.endsWith("@lid") ? msg.key.participant : "");

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
                text: `✅ *[FilmFeed 4K • තහවුරු කිරීම සාර්ථකයි!]*\n\nස්තූතියි *${pushName}*! ඔබ ${groupNames} සමූහය හා සම්බන්ධ වී ඇති බව තහවුරු විය. 🎉\n\n🚀 ඔබ ඉල්ලූ *${taskItem.isSeriesSeason ? `TV Series (Season ${taskItem.seasonNumber})` : "චිත්‍රපටය"}* දැන් බාගත කිරීම සඳහා පෝලිමට එක් කරන ලදී! 🍿`,
              });

              requestQueue.push(taskItem);
              triggerQueue();
              continue;
            } else {
              await waSocket.sendMessage(remoteJid, {
                text: `⚠️ *[FilmFeed 4K]* තවමත් ඔබ කිසිදු සමූහයකට (Group) එකතු වී නොමැත. කරුණාකර පළමුව Group එකට එකතු වී නැවත *done* ලෙස එවන්න.`,
              });
              continue;
            }
          }
        }

        // Parse commands
        let commandFound = false;
        let isSeriesSeason = false;
        let isAnimeSeason = false;
        let seasonNumber = 1;
        let movieUrl = "";
        let quality = "720p";
        let token = "";

        const textLines = text.split("\n");

        for (const rawLine of textLines) {
          const line = rawLine.trim();
          if (!line) continue;

          // Anime Command: !anime <query_or_slug> | <season_str> | <quality> | <token>
          const aMatch =
            line.match(/^[!/.]?anime\s+([^|\n]+?)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?$/i);
          if (aMatch) {
            commandFound = true;
            isAnimeSeason = true;
            movieUrl = aMatch[1].trim();
            seasonNumber = aMatch[2] ? (parseInt(aMatch[2].replace(/\D/g, ""), 10) || 1) : 1;
            quality = aMatch[3] ? aMatch[3].trim() : (aMatch[2] && aMatch[2].includes("p") ? aMatch[2].trim() : "720p");
            token = aMatch[4] ? aMatch[4].trim() : "";
            break;
          }

          // Season Command: !req_season, /season, .season, or !req <url> | S1
          const sMatch =
            line.match(/^[!/.]?(?:req_season|season)\s+([^\s|]+)(?:\s*\|\s*[Ss]?(\d+))?(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i) ||
            line.match(/^[!/.]?req(?:uest)?\s+([^\s|]+)\s*\|\s*[Ss](\d+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);

          if (sMatch && (sMatch[1].startsWith("http") || sMatch[1].includes("cinesubz") || sMatch[1].includes("sinhalasub") || sMatch[1].includes("baiscopes") || sMatch[1].includes("anime") || sMatch[1].includes("cartoons"))) {
            commandFound = true;
            isSeriesSeason = true;
            movieUrl = sMatch[1].trim();
            seasonNumber = sMatch[2] ? parseInt(sMatch[2].trim(), 10) : 1;
            quality = sMatch[3] ? sMatch[3].trim() : "720p";
            token = sMatch[4] ? sMatch[4].trim() : "";
            break;
          }

          // Movie Command: !req <url_or_title> | <quality> | <token>
          const rMatch = line.match(/^[!/.](?:req(?:uest)?)\s+([^|\n]+?)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?$/i);
          if (rMatch) {
            const rawTarget = rMatch[1].trim();
            if (rawTarget && rawTarget.length >= 2) {
              commandFound = true;
              movieUrl = rawTarget;
              quality = rMatch[2] ? rMatch[2].trim() : "720p";
              token = rMatch[3] ? rMatch[3].trim() : "";
              if (movieUrl.includes("/tvshows/")) {
                isSeriesSeason = true;
                seasonNumber = 1;
              }
              break;
            }
          }
        }

        // Fallback: Search anywhere for CineSubz, SinhalaSub, Baiscopes, Anime or Cartoons URL
        if (!commandFound) {
          const urlMatch = text.match(/(https?:\/\/[^\s|]*(?:cinesubz|sinhalasub|baiscopes|animegg|anime|cartoons)[^\s|\n]*)/i);
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

        // If not a command or movie/series link, skip immediately (No Auto-Chat interference!)
        if (!commandFound || !movieUrl) {
          continue;
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
            isVip: false,
            isBanned: false,
          };
        }
        const userRecord = stats[senderPhone];
        checkAndResetDaily(userRecord);

        if (isAdmin) {
          userRecord.isVip = true;
          userRecord.isBanned = false;
        }

        if (text.includes("👑 VIP Member") || text.includes("VIP") || token.toUpperCase().includes("VIP") || text.includes("👑")) {
          userRecord.isVip = true;
          saveUserStats(stats);
        }

        // Check if user is manually banned by admin
        if (!isAdmin && userRecord.isBanned) {
          logger.warn(`🚫 Ignoring request from BANNED user ${senderPhone} (${pushName})`);
          await waSocket.sendMessage(replyTarget, {
            text: `🚫 *[FilmFeed System - Account Suspended]*\n\n👤 *User:* +${senderPhone}\n⚠️ ඔබගේ ගිණුම තාවකාලිකව අත්හිටුවා ඇත. කරුණාකර Admin (+94782088603) අමතන්න.`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // Check if exact movie is ALREADY active or queued (Friendly notice, NO BANS!)
        const isAlreadyQueuedOrActive =
          (currentProcessingItem && currentProcessingItem.cleanUrl === cleanUrl) ||
          requestQueue.some((item) => item.cleanUrl === cleanUrl && item.senderPhone === senderPhone);

        if (isAlreadyQueuedOrActive) {
          await waSocket.sendMessage(replyTarget, {
            text: `⏳ *[FilmFeed Auto-Bot]*\n━━━━━━━━━━━━━━━━━━━━\nආයුබෝවන් *${pushName}*! ඔබ ඉල්ලූ මෙම චිත්‍රපටය දැනටමත් පෝලිමේ (Queue) සැකසෙමින් පවතී. කරුණාකර සුළු මොහොතක් රැඳී සිටින්න. 🍿`,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // Daily limit check for Non-VIP (6 movies per day)
        const isVipUser = Boolean(isAdmin || userRecord.isVip);
        if (!isVipUser && userRecord.dailyCount >= 6) {
          logger.info(`User ${senderPhone} reached daily limit of 6 movies.`);
          const limitMessage =
`⚠️ *[FilmFeed 4K • දෛනික සීමාව ඉක්මවා ඇත (Daily Limit Exceeded)]*
━━━━━━━━━━━━━━━━━━━━
ආයුබෝවන් *${pushName}* (${mentionTag})!
ඔබ අද දිනට හිමි නොමිලේ ලබාගත හැකි චිත්‍රපට 6 ක උපරිම සීමාව (*6/6 Movies*) සම්පූර්ණ කර ඇත.

⏳ *නැවත Reset වන වේලාව:* හෙට උදෑසන 12:00 AM
👑 *අසීමිතව ලබා ගැනීමට VIP සක්‍රීය කරගන්න:*
👉 https://web-umber-six-e1un7z6257.vercel.app
━━━━━━━━━━━━━━━━━━━━`;

          await waSocket.sendMessage(replyTarget, {
            text: limitMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        const userStats = incrementUserRequest(senderPhone, pushName);
        const { count, badge } = userStats;

        // Check Group Membership
        let userGroups = [];
        if (isAdmin || isGroup) {
          userGroups = [{ jid: (isGroup ? remoteJid : TARGET_GROUP_JID), subject: "FilmFeed Cinema Group" }];
        } else {
          userGroups = await checkUserGroups(waSocket, cleanPhone, requesterJid, requesterLid, false);
        }

        const taskItem = {
          isSeriesSeason,
          isAnimeSeason,
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
`⚠️ *[FilmFeed 4K • Group Membership Required]*
━━━━━━━━━━━━━━━━━━━━
ආයුබෝවන් *${pushName}*! 🎬
චිත්‍රපට හා TV Series Upload කරනු ලබන්නේ අපගේ Groups වලට පමණි.
කරුණාකර පහත Group Link එකෙන් අපගේ සමූහයට එකතු වන්න:

${linksText || "Admin අමතන්න: +94 76 037 2547"}

━━━━━━━━━━━━━━━━━━━━
✅ *Join වූ පසු:* මෙම චැට් එකට *done* ලෙස Reply කරන්න! 🍿`;

          await waSocket.sendMessage(replyTarget, {
            text: joinRequiredMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          });
          continue;
        }

        // Add to queue
        const queuePosition = requestQueue.length + (isProcessingQueue ? 1 : 0);

        if (isProcessingQueue) {
          logger.info(`Task added to queue at #${queuePosition} for ${pushName}`);
          const queueMessage =
`⏳ *[FilmFeed Auto-Bot] පෝලිමේ රඳවා ඇත (Queued)*
━━━━━━━━━━━━━━━━━━━━
ආයුබෝවන් *${pushName}* (${mentionTag}),
දැනට වෙනත් චිත්‍රපටයක් බාගත වෙමින් පවතී.

📊 *ඔබගේ පෝලිම් ස්ථානය (Queue Position):* *#${queuePosition}*
📦 *ඉල්ලීම:* ${isSeriesSeason ? `TV Series (Season ${seasonNumber})` : "Movie"}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
📺 *Quality:* ${quality}
🔑 *Token:* ${token || "DIRECT"}
━━━━━━━━━━━━━━━━━━━━
_කලින් ඉල්ලීම අවසන් වූ සැණින් ඔබගේ ඉල්ලීම බාගත කර Group එකට Upload වනු ඇත!_`;

          const qSent = await waSocket.sendMessage(replyTarget, {
            text: queueMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          }).catch(() => null);
          if (qSent?.key) {
            taskItem.statusMsgKey = qSent.key;
          }
        } else {
          const startMessage =
`🚀 *[FilmFeed Auto-Bot] සකසමින් පවතී (Processing)*
━━━━━━━━━━━━━━━━━━━━
ආයුබෝවන් *${pushName}* (${mentionTag})!
ඔබගේ *${count}* වන ඉල්ලීම ලැබුණා [${badge}].
${isSeriesSeason ? `📺 *TV Series (Season ${seasonNumber}) Pack* සකස් කිරීම ආරම්භ විය...` : "🎬 Direct High-Speed ලින්ක් එක සකසා බාගත කිරීම ආරම්භ විය..."}

📺 *Quality:* ${quality}
🔑 *Token:* ${token || "DIRECT"}
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed 4K Cinema Engine`;

          const sSent = await waSocket.sendMessage(replyTarget, {
            text: startMessage,
            mentions: mentionsList,
            contextInfo: getMetaAiContext(mentionsList),
          }).catch(() => null);
          if (sSent?.key) {
            taskItem.statusMsgKey = sSent.key;
          }
        }

        requestQueue.push(taskItem);
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
  console.log("🚀 STARTING FILMFEED MASTER BOT (0782088603) - 24/7 ONLINE");
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

    const ipv4Agent = new https.Agent({
      family: 4,
      keepAlive: true,
      keepAliveMsecs: 30000,
      timeout: 1800000,
    });

    const sock = makeWASocket({
      version,
      logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "warn" })),
      },
      fetchAgent: ipv4Agent,
      options: {
        httpsAgent: ipv4Agent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
      generateHighQualityLinkPreview: false,
      browser: Browsers.ubuntu("Chrome"),
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 1800000,
      mediaUploadTimeoutMs: 1800000,
      mediaCache: new Map(),
      getMessage: async (key) => {
        if (key?.id && messageStore.has(key.id)) {
          return messageStore.get(key.id);
        }
        return undefined;
      },
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
        sessionManager.updateGistFile("latest_qr.txt", qr).catch(() => {});
        console.log("\n============================================================");
        console.log("📱 [FilmFeed Master Bot (0782088603)] SCAN QR CODE WITH WHATSAPP:");
        console.log("👉 WhatsApp on 0782088603 -> Linked Devices -> Link a Device");
        console.log("============================================================\n");
        qrcode.generate(qr, { small: true });
        console.log("\n============================================================\n");
      }

      if (connection === "open") {
        console.log("\n============================================================");
        console.log("✅ FILMFEED MASTER BOT (0782088603) CONNECTED SUCCESSFULLY!");
        console.log("🎬 Movies & TV Series 24/7 Engine Active");
        console.log("============================================================\n");
        isConnected = true;
        latestQR = null;
        reconnectAttempts = 0;
        sessionManager.updateGistFile("latest_qr.txt", "CONNECTED_OK: " + new Date().toISOString() + " | Phone: " + (sock.user?.id || BOT_PHONE)).catch(() => {});
        await sessionManager.sync();

        triggerQueue();
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
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
