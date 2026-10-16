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
const { execFile, execFileSync } = require("child_process");
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

async function resolveGameRepack(gameUrl) {
  return new Promise((resolve, reject) => {
    const resolverScript = path.join(__dirname, "../fitgirl_resolver.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    execFile(pythonCmd, [resolverScript, gameUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "FitGirl Game resolver error");
        return reject(err);
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse FitGirl resolver JSON");
        reject(parseErr);
      }
    });
  });
}

async function downloadGamePart(url, destPath) {
  return new Promise((resolve, reject) => {
    const downloaderScript = path.join(__dirname, "../downloader.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const args = [downloaderScript, "--download-part", url, "--dest", destPath];

    logger.info(`[Game Downloader] Invoking Playwright stealth downloader for part: ${url}`);
    execFile(pythonCmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logger.error({ err, stderr }, "Game part downloader error");
        return reject(err);
      }
      try {
        const lines = stdout.trim().split("\n");
        let parsed = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i].trim());
            break;
          } catch (_) {}
        }
        if (parsed && parsed.success && fs.existsSync(destPath) && fs.statSync(destPath).size > 100000) {
          logger.info(`[Game Downloader] Part downloaded successfully! Size: ${Math.round(parsed.size / 1024 / 1024)}MB`);
          resolve(parsed);
        } else {
          reject(new Error(parsed?.error || stderr || "Failed to download game RAR part"));
        }
      } catch (parseErr) {
        logger.error({ stdout, stderr }, "Failed to parse downloader JSON");
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
async function getPosterThumbnail(posterUrl, thumbnailB64 = null) {
  if (thumbnailB64) {
    try {
      const buf = Buffer.from(thumbnailB64, "base64");
      if (buf.length > 500 && buf.length < 35000) {
        return buf;
      }
    } catch (_) {}
  }
  if (!posterUrl) return null;
  try {
    const res = await axios.get(posterUrl, {
      responseType: "arraybuffer",
      timeout: 8000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    const rawBuf = Buffer.from(res.data);
    if (rawBuf.length < 32000) {
      return rawBuf;
    }
    return null;
  } catch (err) {
    return null;
  }
}

function getMetaAiContext(mentionsList = []) {
  return {
    forwardingScore: 1,
    isForwarded: false,
    quotedMessage: {
      extendedTextMessage: {
        text: "🤖 Meta AI • FilmFeed 4K Cinema Delivery Engine",
      },
    },
    participant: "13135550002@s.whatsapp.net",
    remoteJid: "status@broadcast",
    mentionedJid: mentionsList,
  };
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
    isGameRequest,
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
    `[Queue Engine] Processing task for ${pushName}: ${movieUrl} | Type=${isGameRequest ? "FitGirl PC Game" : isSeriesSeason ? `Series S${seasonNumber}` : "Movie"} | Remaining in queue: ${requestQueue.length}`
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
    // MODE C: PC GAME REPACK MULTIPART BATCH (FitGirl Repacks - Private Delivery)
    // ----------------------------------------------------------------------
    if (isGameRequest) {
      // Determine the user's private WhatsApp chat target
      const directTarget = (replyTarget && !replyTarget.endsWith("@g.us"))
        ? replyTarget
        : (requesterJid || replyTarget);

      // If requested from inside a group, send a polite notice in the group that delivery is in DM
      if (replyTarget && replyTarget.endsWith("@g.us")) {
        try {
          await waSocket.sendMessage(replyTarget, {
            text: `🎮 *[FilmFeed Games 4K]*\n\n*${pushName}* (${mentionTag}), ඔබ ඉල්ලූ Game Repack එක Group එක පිරීම වැළැක්වීම සඳහා ඔබගේ WhatsApp Inbox (Private Chat) වෙත කෙලින්ම ලැබෙනු ඇත! 📥`,
            mentions: mentionsList,
          });
        } catch (_) {}
      }

      await waSocket.sendMessage(directTarget, {
        text: `🎮 *[FilmFeed Games 4K Engine]*\n\n*${pushName}*, ඔබ ඉල්ලූ Game Repack එක සැකසීම ආරම්භ විය!\nසියලුම Archive Parts (~500MB) පිළිවෙළින් බාගත වී ඔබගේ මෙම Private Chat එකටම ලැබෙනු ඇත. 🚀`,
      });

      const gameData = await resolveGameRepack(movieUrl);
      if (!gameData || !gameData.success || !gameData.parts || gameData.parts.length === 0) {
        await waSocket.sendMessage(directTarget, {
          text: `❌ *[FilmFeed Games]* Game Repack එක සඳහා Download Parts සොයාගත නොහැකි විය: ${gameData?.error || "Unknown error"}`,
        });
        isProcessingQueue = false;
        currentProcessingItem = null;
        processQueue();
        return;
      }

      const gameTitle = gameData.title || "PC Game";
      const posterUrl = gameData.poster;
      const totalParts = gameData.total_parts || gameData.parts.length;

      // 1. Send Game Overview Poster to User's Private Chat
      const gameCaption =
`🎮 *${gameTitle}*
━━━━━━━━━━━━━━━━━━━━
📦 *Pack Type:* FitGirl Repack Archive (Direct Private Delivery)
🔢 *Total Parts:* ${totalParts} RAR Parts (~500MB each)
💾 *Repack Size:* ${gameData.repack_size || "Full Repack"}
💾 *Original Size:* ${gameData.original_size || "N/A"}
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
🔑 *Token:* ${token || "VIP_GAME"}
━━━━━━━━━━━━━━━━━━━━
⚡ _Part 1 සිට Part ${totalParts} දක්වා පිළිවෙළින් බාගත වී මෙම Chat එකට ලැබෙනු ඇත. සියලුම කොටස් ලැබෙන තුරු කරුණාකර රැඳී සිටින්න!_`;

      if (posterUrl) {
        await waSocket.sendMessage(directTarget, {
          image: { url: posterUrl },
          caption: gameCaption,
        });
      } else {
        await waSocket.sendMessage(directTarget, {
          text: gameCaption,
        });
      }

      // 2. Deliver each part sequentially to the user's private chat
      let deliveredCount = 0;
      for (let pIdx = 0; pIdx < gameData.parts.length; pIdx++) {
        const partObj = gameData.parts[pIdx];
        const partNumber = pIdx + 1;
        const partFileName = partObj.filename || `${gameTitle}.part${partNumber}.rar`;
        const tempPartPath = path.join(__dirname, `../temp_game_${Date.now()}_part${partNumber}.rar`);

        logger.info(`[Game Engine] (${partNumber}/${totalParts}) Downloading ${partFileName} for ${directTarget}...`);

        let partDownloadSuccess = false;
        try {
          await downloadGamePart(partObj.url, tempPartPath);
          partDownloadSuccess = fs.existsSync(tempPartPath) && fs.statSync(tempPartPath).size > 100000;
        } catch (dlErr) {
          logger.warn(`Playwright downloader error for part ${partNumber}: ${dlErr.message}`);
        }

        if (!partDownloadSuccess) {
          try {
            await downloadFile(partObj.url, tempPartPath);
            partDownloadSuccess = fs.existsSync(tempPartPath) && fs.statSync(tempPartPath).size > 100000;
          } catch (e2) {
            logger.error(`Fallback download error for part ${partNumber}: ${e2.message}`);
          }
        }

        if (partDownloadSuccess) {
          const fileSizeMB = Math.round(fs.statSync(tempPartPath).size / 1024 / 1024);
          const partBuffer = fs.readFileSync(tempPartPath);

          await waSocket.sendMessage(directTarget, {
            document: partBuffer,
            mimetype: "application/x-rar-compressed",
            fileName: partFileName,
            caption:
`🎮 *${gameTitle}* [Part ${partNumber}/${totalParts}] (${fileSizeMB}MB)
━━━━━━━━━━━━━━━━━━━━
📦 *Archive:* ${partFileName}
⚡ *Status:* Part ${partNumber} of ${totalParts} Delivered Directly
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed Games 4K Engine`,
            contextInfo: getMetaAiContext(),
          });

          deliveredCount++;
          if (fs.existsSync(tempPartPath)) {
            fs.unlinkSync(tempPartPath);
          }
          logger.info(`[Game Engine] Successfully delivered part ${partNumber}/${totalParts} to ${directTarget}`);
        } else {
          await waSocket.sendMessage(directTarget, {
            text: `⚠️ *[FilmFeed Games - Part ${partNumber}/${totalParts}]*\n${partFileName}\nDirect Cloud Mirror: ${partObj.url}`,
          });
        }
      }

      // 3. Final summary to user's private chat
      await waSocket.sendMessage(directTarget, {
        text:
`✅ *[FilmFeed Games - Repack Completed!]*
━━━━━━━━━━━━━━━━━━━━
🎮 *${gameTitle}*
📦 Delivered: *${deliveredCount} / ${totalParts} Parts*
💡 *Instructions:*
1. Download all ${totalParts} RAR parts to the same folder on your PC.
2. Right click *Part 1* -> Extract Here (WinRAR / 7-Zip).
3. Open the extracted folder and run setup.exe to install and play!
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed Games 4K Portal: https://fitgirl-web.vercel.app`,
      });

      incrementUserRequest(requesterJid || replyTarget, pushName, gameTitle, "PC Game");

      isProcessingQueue = false;
      currentProcessingItem = null;
      processQueue();
      return;
    }

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
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
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

          if (directUrl.includes("t.me") || epData.is_telegram) {
            await downloadTelegramFile(directUrl, tempFilePath);
          } else if (epData.is_gdrive || directUrl.includes("drive.google.com")) {
            await downloadGDriveFile(directUrl, tempFilePath, resolvedQuality);
          } else {
            await downloadFile(directUrl, tempFilePath);
          }

          const fileBuffer = fs.readFileSync(tempFilePath);
          const epThumbnail = await getPosterThumbnail(epData.poster || epData.backdrop || movieData?.poster, epData.thumbnail_b64);

          // Upload Episode Document to All Groups
          await broadcastToGroups({
            document: fileBuffer,
            mimetype: "video/mp4",
            fileName: `${epTitle} [${resolvedQuality}] [FilmFeed].mp4`,
            caption: `✅ *${epTitle}* (${resolvedQuality})\n👤 Requested By: ${mentionTag}\n📦 Season ${seasonNumber} Pack [${epIndex}/${totalEpisodes} Episodes]\n✨ Uploaded by FilmFeed Auto-Bot`,
            mentions: mentionsList,
            ...(epThumbnail ? { jpegThumbnail: epThumbnail } : {}),
            contextInfo: getMetaAiContext(mentionsList),
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
      const posterUrl = movieData.backdrop || movieData.poster;
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
`🎬 *[FilmFeed Downloader]*
━━━━━━━━━━━━━━━━━━━━
📌 *චිත්‍රපටය:* *${title}* (${resolvedQuality})
👤 *Requested By:* ${pushName} [${badge}]
⏳ *තත්ත්වය:* Telegram හරහා බාගත වෙමින් පවතී...
📥 *Download Progress:* ${percent}% (${dMB}MB / ${tMB}MB)
⚡ *Speed:* ${speedText} (MTProto Secure Stream)
━━━━━━━━━━━━━━━━━━━━`,
                edit: liveStatusMsg.key,
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
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *User Stats:* ඔබගේ ${count} වන ඉල්ලීම [${badge}]
🌟 *Quality:* ${resolvedQuality} ${movieData.size_text ? `(${movieData.size_text})` : `(${finalSizeMB}MB)`}
🔑 *Token:* ${token || "DIRECT"}
⚡ *Audio / Sub:* Sinhala Subtitles Included
━━━━━━━━━━━━━━━━━━━━
📝 *Storyline / සාරාංශය:*
${movieData.description ? movieData.description.substring(0, 420) + "..." : "FilmFeed Direct Release"}

🍿 _චිත්‍රපටය පහතින් Document එකක් ලෙස ලැබෙනු ඇත!_`;

      const effectivePoster = posterUrl || movieData.backdrop || movieData.poster;
      if (effectivePoster) {
        await broadcastToGroups({
          image: { url: effectivePoster },
          caption: caption,
          mentions: mentionsList,
        });
      } else {
        await broadcastToGroups({
          text: caption,
          mentions: mentionsList,
        });
      }

      // 4. Upload Document to all groups with Movie Poster Thumbnail & Meta AI Styling
      logger.info(`Uploading ${finalSizeMB}MB document to WhatsApp groups...`);
      
      const fileBuffer = fs.readFileSync(tempFilePath);
      const thumbBuffer = await getPosterThumbnail(effectivePoster, movieData?.thumbnail_b64);
      
      await broadcastToGroups({
        document: fileBuffer,
        mimetype: "video/mp4",
        fileName: `${title} [${resolvedQuality}] [FilmFeed].mp4`,
        caption: 
`🎬 *${title}* (${resolvedQuality})
━━━━━━━━━━━━━━━━━━━━
👤 *Requested By:* ${currentTask.mentionDisplay || mentionTag}
🎯 *User Stats:* ${count} වන සාර්ථක නිකුතුව! [${badge}]
⚡ *Status:* Group Broadcast Completed
━━━━━━━━━━━━━━━━━━━━
🍿 FilmFeed 4K Auto-Bot Engine
👉 Request: https://web-umber-six-e1un7z6257.vercel.app`,
        mentions: mentionsList,
        ...(thumbBuffer ? { jpegThumbnail: thumbBuffer } : {}),
        contextInfo: getMetaAiContext(mentionsList),
      });

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
      return undefined;
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

    // 4.5 Hours Graceful Runner Rotation (prevents hard kills by GitHub Actions)
    const RUNNER_LIFETIME_HOURS = parseFloat(process.env.RUNNER_LIFETIME_HOURS || "4.5");
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

      // Print very clearly in GitHub Actions log
      console.log("\n");
      console.log("##################################################");
      console.log("##################################################");
      console.log("##                                              ##");
      console.log("##   📲 WHATSAPP QR CODE - SCAN NOW!           ##");
      console.log("##                                              ##");
      console.log("##################################################");
      console.log("##################################################");
      console.log("");
      console.log("👇 OPEN THIS LINK IN YOUR BROWSER TO SCAN:");
      console.log("");
      console.log("🔗 " + qrUrl);
      console.log("");
      console.log("📱 WhatsApp → Settings → Linked Devices → Link a Device");
      console.log("");
      console.log("##################################################");
      console.log("\n");

      // Also print terminal QR as fallback
      qrcode.generate(qr, { small: true });

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
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      logger.warn(
        `Connection closed (code: ${statusCode}, error: ${lastDisconnect?.error}). Reconnecting...`
      );

      if (isLoggedOut) {
        logger.warn("🚨 Session was logged out/revoked by WhatsApp (Code 401). Purging dead session from vault and starting fresh QR...");
        // Wipe ALL local auth files so next startBot() goes straight to QR
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (_) {}
        // Clear vault so restore() returns false on next startup
        await cloudSession.clearVault();
        // Reset socket reference
        waSocket = null;
        isConnected = false;
        logger.warn("🔄 Starting fresh bot instance for QR scan...");
        setTimeout(startBot, 2000);
        return;
      }

      const delay = statusCode === 515 ? 1000 : 3000;
      setTimeout(startBot, delay);
    } else if (connection === "open") {
      latestQR = null;
      isConnected = true;
      logger.info(`✅ FilmFeed Bot Connected successfully! Active on: ${BOT_PHONE}`);
      logger.info(`🎯 Target Group: ${TARGET_GROUP_JID}`);
      await cloudSession.sync();
      const ghToken = process.env.GH_PAT || process.env.GITHUB_TOKEN;
      const vaultId = process.env.SESSION_VAULT_ID || "8f37b6dbcf07ff6fab07b21cc8cbe05b";
      if (ghToken && vaultId) {
        axios.patch(`https://api.github.com/gists/${vaultId}`, {
          files: {
            "latest_qr.txt": { content: "CONNECTED_OK: " + new Date().toISOString() },
          },
        }, {
          headers: {
            Authorization: "Bearer " + ghToken,
            Accept: "application/vnd.github+json",
            "User-Agent": "FilmFeed-QR",
          },
          timeout: 8000,
        }).catch(() => {});
      }
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
    // Only process new incoming messages — skip history sync replays on startup
    if (m.type !== "notify") return;
    if (!m.messages || m.messages.length === 0) return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      try {
        const remoteJid = msg.key.remoteJid || "";
        const fromMe = Boolean(msg.key.fromMe);

        // Unwrap potential layers: ephemeral, viewOnce, document captions
        let innerMsg = msg.message;
        if (innerMsg?.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
        if (innerMsg?.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
        if (innerMsg?.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;
        if (innerMsg?.documentWithCaptionMessage?.message) innerMsg = innerMsg.documentWithCaptionMessage.message;

        const rawText =
          innerMsg?.conversation ||
          innerMsg?.extendedTextMessage?.text ||
          innerMsg?.imageMessage?.caption ||
          innerMsg?.videoMessage?.caption ||
          "";

        const text = rawText.trim();
        if (!text) continue;

        const isCommandText = /^[!/.](?:req|game|vip|unvip|unban|ban|unlimit|reset|stats|done|verify)/i.test(text) || text.includes("!req");

        // Skip bot's own automated messages (only allow commands sent from owner account)
        if (fromMe && !isCommandText) continue;

        const isGroup = remoteJid.endsWith("@g.us");
        const participant = msg.key.participant || "";

        let requesterPhone = "";
        let requesterLid = "";
        let requesterJid = "";

        if (fromMe) {
          requesterPhone = BOT_PHONE;
          requesterJid = `${BOT_PHONE}@s.whatsapp.net`;
        } else if (isGroup) {
          if (participant.endsWith("@s.whatsapp.net")) {
            requesterPhone = participant.split("@")[0].replace(/:\d+/, "");
            requesterJid = `${requesterPhone}@s.whatsapp.net`;
          } else if (participant.endsWith("@lid")) {
            requesterLid = participant.replace(/:\d+/, "");
          }
        } else {
          if (remoteJid.endsWith("@s.whatsapp.net")) {
            requesterPhone = remoteJid.split("@")[0].replace(/:\d+/, "");
            requesterJid = `${requesterPhone}@s.whatsapp.net`;
          } else if (remoteJid.endsWith("@lid")) {
            requesterLid = remoteJid.replace(/:\d+/, "");
          }
        }

        // If user reached via LID, resolve their real phone from group participants
        if (requesterLid && !requesterPhone) {
          const resolved = await resolveRealPhoneFromGroups(waSocket, requesterLid);
          if (resolved) {
            requesterPhone = resolved;
            requesterJid = `${requesterPhone}@s.whatsapp.net`;
          }
        }

        const rawPhone = requesterPhone || (remoteJid.includes("@") ? remoteJid.split("@")[0].replace(/:\d+/, "") : "");
        const cleanPhone = (rawPhone && rawPhone.length >= 9 && rawPhone.length <= 15) ? rawPhone : (fromMe ? BOT_PHONE : "");
        const cleanJid = cleanPhone ? `${cleanPhone}@s.whatsapp.net` : null;
        const senderPhone = cleanPhone || (requesterLid ? requesterLid.split("@")[0].replace(/:\d+/, "") : rawPhone) || BOT_PHONE;

        const isAdmin = fromMe || cleanPhone === "94760372547" || cleanPhone === BOT_PHONE || senderPhone === "94760372547" || senderPhone === BOT_PHONE;

        const pushName = msg.pushName || (cleanPhone ? `+${cleanPhone}` : "Movie Fan");
        const mentionTag = cleanPhone ? `@${cleanPhone}` : `@${pushName}`;
        const mentionDisplay = cleanPhone ? `@${cleanPhone} (${pushName})` : `@${pushName}`;
        const mentionsList = [requesterJid, requesterLid, cleanJid, (isGroup ? participant : remoteJid)].filter(Boolean);

        // Log every incoming message for debugging
        console.log(`📩 [Msg Received] from: ${pushName} (${senderPhone}) | jid: ${remoteJid} | fromMe: ${fromMe} | isAdmin: ${isAdmin}:\n${text}`);

        // Admin Management Commands
        if (isAdmin && text.startsWith("!")) {
          const parts = text.split(/\s+/);
          const adminCmd = parts[0].toLowerCase();
          const targetPhone = parts[1] ? parts[1].replace(/[^0-9]/g, "") : (cleanPhone || BOT_PHONE);

          if (adminCmd === "!unban" && targetPhone) {
            const allStats = getUserStats();
            if (allStats[targetPhone]) {
              allStats[targetPhone].isBanned = false;
              allStats[targetPhone].duplicateCount = 0;
              saveUserStats(allStats);
              await waSocket.sendMessage(remoteJid, { text: `✅ User +${targetPhone} has been UNBANNED successfully.` });
              continue;
            }
          } else if (adminCmd === "!ban" && targetPhone) {
            const allStats = getUserStats();
            if (!allStats[targetPhone]) allStats[targetPhone] = { count: 0, name: "User", firstSeen: new Date().toISOString() };
            allStats[targetPhone].isBanned = true;
            allStats[targetPhone].bannedAt = new Date().toISOString();
            allStats[targetPhone].banReason = parts.slice(2).join(" ") || "Manually banned by Admin";
            saveUserStats(allStats);
            await waSocket.sendMessage(remoteJid, { text: `🚫 User +${targetPhone} has been BANNED.` });
            continue;
          } else if (adminCmd === "!vip") {
            const allStats = getUserStats();
            if (!allStats[targetPhone]) allStats[targetPhone] = { count: 0, name: "User", firstSeen: new Date().toISOString() };
            allStats[targetPhone].isVip = true;
            allStats[targetPhone].dailyCount = 0;
            allStats[targetPhone].isBanned = false;
            saveUserStats(allStats);
            await waSocket.sendMessage(remoteJid, { text: `👑 VIP status ACTIVATED for +${targetPhone}. Unlimited requests enabled! 🚀` });
            continue;
          } else if (adminCmd === "!unvip") {
            const allStats = getUserStats();
            if (allStats[targetPhone]) {
              allStats[targetPhone].isVip = false;
              saveUserStats(allStats);
              await waSocket.sendMessage(remoteJid, { text: `❌ VIP status REVOKED for +${targetPhone}.` });
              continue;
            }
          } else if (adminCmd === "!unlimit" || adminCmd === "!reset") {
            const allStats = getUserStats();
            if (parts[1]?.toLowerCase() === "all") {
              for (const k of Object.keys(allStats)) {
                allStats[k].dailyCount = 0;
              }
              saveUserStats(allStats);
              await waSocket.sendMessage(remoteJid, { text: `🔄 All user daily limits have been RESET to 0/6!` });
            } else {
              if (!allStats[targetPhone]) allStats[targetPhone] = { count: 0, name: "User", firstSeen: new Date().toISOString() };
              allStats[targetPhone].dailyCount = 0;
              saveUserStats(allStats);
              await waSocket.sendMessage(remoteJid, { text: `🔄 Daily limit for +${targetPhone} has been RESET to 0/6!` });
            }
            continue;
          } else if (adminCmd === "!stats") {
            const allStats = getUserStats();
            const u = allStats[targetPhone];
            if (u) {
              checkAndResetDaily(u);
              await waSocket.sendMessage(remoteJid, {
                text: `📊 *[User Info: +${targetPhone}]*\nName: ${u.name}\nDaily: ${u.dailyCount}/6\nTotal: ${u.count}\nVIP: ${u.isVip ? "YES 👑" : "NO"}\nBanned: ${u.isBanned ? "YES 🚫" : "NO"}`,
              });
              continue;
            }
          }
        }

        // ------------------------------------------------------------------
        // Check for Group Join Verification Command: !done / done / verify
        // ------------------------------------------------------------------
        const lowerTrimmed = text.trim().toLowerCase();
        if (["!done", "done", ".done", "/done", "verify", "!verify", "join", "!join"].includes(lowerTrimmed)) {
          const pendingKey = cleanPhone || requesterLid || senderPhone;
          const pending = pendingGroupRequests.get(pendingKey);
          if (!pending) {
            await waSocket.sendMessage(remoteJid, {
              text: `👋 ආයුබෝවන් *${pushName}*!\nඔබට දැනට Pending වූ Movie Request එකක් නොමැත.\nවෙබ් අඩවියෙන් හෝ *!req <movie_url>* මඟින් ඔබට අවශ්‍ය චිත්‍රපටය Request කරන්න. 🎬`,
            });
            continue;
          }

          // Force-refresh to check if user has joined any of our target groups
          const userGroups = await checkUserGroups(waSocket, cleanPhone, requesterJid, requesterLid, true);
          if (userGroups.length === 0) {
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

            await waSocket.sendMessage(remoteJid, {
              text: `❌ *[FilmFeed 4K] තහවුරු කරගත නොහැකි විය!*\n\n*${pushName}*, ඔබ තවමත් අපගේ කිසිදු WhatsApp සමූහයකට (Group) Join වී නොමැති බව පෙනේ.\n\nකරුණාකර පහත Link එකෙන් Group එකට Join වී නැවත *!done* ලෙස එවන්න:\n\n${linksText || "Admin අමතන්න: +94 76 037 2547"}`,
            });
            continue;
          }

          // User is verified!
          const taskItem = pending.taskItem;
          taskItem.targetGroups = userGroups.map((g) => g.jid);
          taskItem.mentionTag = mentionTag;
          taskItem.mentionDisplay = mentionDisplay;
          taskItem.mentionsList = mentionsList;
          pendingGroupRequests.delete(pendingKey);

          const groupNames = userGroups.map((g) => `*${g.subject}*`).join(", ");
          await waSocket.sendMessage(remoteJid, {
            text: `✅ *[FilmFeed 4K • තහවුරු කිරීම සාර්ථකයි!]*\n\nස්තූතියි *${pushName}*! ඔබ ${groupNames} සමූහය හා සම්බන්ධ වී ඇති බව තහවුරු විය. 🎉\n\n🚀 ඔබ ඉල්ලූ *${taskItem.isSeriesSeason ? `TV Series (Season ${taskItem.seasonNumber})` : "චිත්‍රපටය"}* දැන් බාගත කිරීම ආරම්භ වේ!\n📦 චිත්‍රපටය ඔබ සිටින Group එකට පමණක් Upload වනු ඇත. 🍿`,
          });

          const isBusy = isProcessingQueue || requestQueue.length > 0;
          const queuePosition = requestQueue.length + (isProcessingQueue ? 1 : 0);

          if (isBusy) {
            requestQueue.push(taskItem);
            logger.info(`Task added to queue at #${queuePosition} for ${pushName} after group verification`);
          } else {
            requestQueue.push(taskItem);
            processQueue();
          }
          continue;
        }

        // Skip bot's own non-command messages
        if (fromMe && !isCommandText) continue;

        let commandFound = false;
        let isGameRequest = false;
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

          // 1A. FitGirl Game Command: !req_game, /game, .game, or !req <fitgirl_url>
          const gMatch =
            line.match(/^[!/.]?(?:req_game|game)\s+(https?:\/\/[^\s|]+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i) ||
            line.match(/^[!/.]?req(?:uest)?\s+(https?:\/\/[^\s|]*fitgirl[^\s|]*)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);
          if (gMatch) {
            commandFound = true;
            isGameRequest = true;
            movieUrl = gMatch[1].trim();
            quality = gMatch[2] ? gMatch[2].trim() : "Full Game";
            token = gMatch[3] ? gMatch[3].trim() : "";
            break;
          }

          // 1B. Season Command: !req_season, /season, .season, or !req <url> | S1
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

          // 1C. Movie Command: !req <url> | <quality> | <token>
          const rMatch = line.match(/^[!/.]?req(?:uest)?\s+(https?:\/\/[^\s|]+)(?:\s*\|\s*([^|\n]+))?(?:\s*\|\s*([^\s|\n]+))?/i);
          if (rMatch) {
            commandFound = true;
            movieUrl = rMatch[1].trim();
            quality = rMatch[2] ? rMatch[2].trim() : "720p";
            token = rMatch[3] ? rMatch[3].trim() : "";
            if (movieUrl.includes("fitgirl-repacks.site")) {
              isGameRequest = true;
            } else if (movieUrl.includes("/tvshows/")) {
              isSeriesSeason = true;
              seasonNumber = 1;
            }
            break;
          }
        }

        // 2. Fallback: Search anywhere for a FitGirl, CineSubz, SinhalaSub, Baiscopes, Anime or Cartoons URL if no formal command was triggered
        if (!commandFound) {
          const fgMatch = text.match(/(https?:\/\/[^\s|]*fitgirl-repacks\.site[^\s|\n]*)/i);
          if (fgMatch) {
            commandFound = true;
            isGameRequest = true;
            movieUrl = fgMatch[1].trim();
            quality = "Full Game";
            token = "DIRECT";
          }
        }

        if (!commandFound) {
          const urlMatch = text.match(/(https?:\/\/[^\s|]*(?:cinesubz|sinhalasub|baiscopes|animekaizen|cartoons)[^\s|\n]*)/i);
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

        // Normalize domain to cinesubz.lk for fast direct connection without Cloudflare delays
        movieUrl = movieUrl.replace(/cinesubz\.(net|co)/g, "cinesubz.lk");

        logger.info(`🎯 Accepted FilmFeed command from ${pushName} (${remoteJid}): URL=${movieUrl} | Q=${quality}`);

        const replyTarget = remoteJid;

        // ------------------------------------------------------------------
        // ANTI-SPAM & USER CONTROL CHECKS
        // ------------------------------------------------------------------
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
            duplicateCount: 0,
            lastRequestedUrl: "",
          };
        }
        const userRecord = stats[senderPhone];
        checkAndResetDaily(userRecord);

        // Auto-grant VIP and clear restrictions for Admin / Owner
        if (isAdmin) {
          userRecord.isVip = true;
          userRecord.isBanned = false;
          userRecord.duplicateCount = 0;
          userRecord.dailyCount = 0;
        }

        // Auto-grant VIP if request message contains VIP markers
        if (text.includes("👑 VIP Member") || text.includes("VIP") || token.toUpperCase().includes("VIP") || text.includes("👑")) {
          userRecord.isVip = true;
          saveUserStats(stats);
        }

        // A. CHECK IF USER IS CURRENTLY BANNED (Admins are NEVER banned)
        if (!isAdmin && userRecord.isBanned) {
          logger.warn(`🚫 Ignoring request from BANNED user ${senderPhone} (${pushName})`);
          const banNotice = 
`🚫 *[FilmFeed System - Account BANNED]*
━━━━━━━━━━━━━━━━━━━━
👤 *User Phone:* +${senderPhone} (${mentionTag})
⚠️ *තත්ත්වය:* ඔබගේ WhatsApp අංකය FilmFeed පද්ධතියෙන් BAN කර ඇත.
📌 *හේතුව (Reason):* ${userRecord.banReason || "Duplicate spam requests for the same movie"}

_නැවත සේවාව ලබා ගැනීමට අවශ්‍ය නම් කරුණාකර Admin (+94760372547) අමතන්න._
━━━━━━━━━━━━━━━━━━━━`;

          await waSocket.sendMessage(replyTarget, { text: banNotice, mentions: mentionsList });
          continue;
        }

        // B. CHECK DUPLICATE MOVIE REQUEST (Admins & VIPs are NEVER blocked for duplicate requests)
        const cleanUrl = movieUrl.trim().toLowerCase().replace(/\/+$/, "");
        const prevUrl = (userRecord.lastRequestedUrl || "").trim().toLowerCase().replace(/\/+$/, "");

        if (!isAdmin && !userRecord.isVip && prevUrl && prevUrl === cleanUrl) {
          userRecord.duplicateCount = (userRecord.duplicateCount || 1) + 1;
          userRecord.lastRequestedAt = Date.now();

          if (userRecord.duplicateCount >= 2) {
            // BAN the user immediately!
            userRecord.isBanned = true;
            userRecord.bannedAt = new Date().toISOString();
            userRecord.banReason = "එකම චිත්‍රපටය නැවත නැවතත් (Duplicate Spam Request) ඉල්ලුම් කිරීම";
            saveUserStats(stats);

            logger.warn(`🚨 User ${senderPhone} (${pushName}) BANNED for repeated requests of ${movieUrl}`);

            const banMessage = 
`🚫 *[FilmFeed System - Account BANNED]*
━━━━━━━━━━━━━━━━━━━━
👤 *User:* ${mentionTag} (+${senderPhone})
⚠️ *හේතුව (Ban Reason):*
ඔබ එකම චිත්‍රපටය නැවත නැවතත් (Duplicate Spam Request) ඉල්ලුම් කිරීම හේතුවෙන් පද්ධතියේ ආරක්ෂාව සඳහා ඔබගේ WhatsApp අංකය ස්වයංක්‍රීයව BAN කරන ලදී!

📌 *තත්ත්වය:* ඔබගේ අංකයෙන් ඉදිරියට කිසිදු චිත්‍රපටයක් ලබාගත නොහැක.
💡 *විසඳුම:* නැවත සක්‍රීය කර ගැනීමට අවශ්‍ය නම් කරුණාකර FilmFeed Admin (+94760372547) අමතන්න.
━━━━━━━━━━━━━━━━━━━━`;

            await waSocket.sendMessage(replyTarget, { text: banMessage, mentions: mentionsList });
            continue;
          }
        } else {
          userRecord.duplicateCount = 1;
          userRecord.lastRequestedUrl = cleanUrl;
          userRecord.lastRequestedAt = Date.now();
        }

        // C. CHECK DAILY 6-MOVIE LIMIT FOR NON-VIP (Admins & VIP are NEVER limited)
        const isVipUser = Boolean(
          isAdmin ||
          userRecord.isVip ||
          text.includes("👑 VIP Member") ||
          text.includes("VIP") ||
          token.toUpperCase().includes("VIP")
        );

        if (!isVipUser && userRecord.dailyCount >= 6) {
          logger.info(`User ${senderPhone} reached daily limit of 6 movies.`);
          const limitMessage = 
`⚠️ *[FilmFeed 4K • දෛනික සීමාව ඉක්මවා ඇත (Daily Limit Exceeded)]*
━━━━━━━━━━━━━━━━━━━━
ආයුබෝවන් *${pushName}* (${mentionTag})!

📌 *දෛනික නොමිලේ සීමාව (Daily Free Limit):*
ඔබ අද දිනට හිමි නොමිලේ ලබාගත හැකි චිත්‍රපට 6 ක උපරිම සීමාව (*6/6 Movies*) සම්පූර්ණ කර ඇත.

📊 *අද දින ඔබ ලබාගත් ප්‍රමාණය:* 6 / 6 චිත්‍රපට
⏳ *නැවත Reset වන වේලාව:* හෙට උදෑසන 12:00 AM (මධ්‍යම රාත්‍රිය)

👑 *අසීමිතව (Unlimited) චිත්‍රපට ලබා ගැනීමට අවශ්‍යද?*
ඔබට අපගේ *VIP සාමාජිකත්වය (VIP Membership)* සක්‍රීය කරගත හැක:

✨ *VIP සාමාජිකත්වයේ විශේෂ වරප්‍රසාද:*
• 🎬 දිනකට කැමති තරම් ඕනෑම චිත්‍රපට සංඛ්‍යාවක් (Unlimited Daily Movies)
• 📦 Full TV Series Season Packs එකවර ලබා ගැනීම
• ⚡ High-Speed Ultra VIP Queue ප්‍රමුඛතාවය (පෝලිම් නැත)
• 🚫 කිසිදු සීමාවකින් තොර වීම

👉 *VIP සක්‍රීය කරගැනීමට පිවිසෙන්න:*
https://web-umber-six-e1un7z6257.vercel.app

හෝ Admin අමතන්න: +94 76 037 2547
━━━━━━━━━━━━━━━━━━━━`;

          await waSocket.sendMessage(replyTarget, {
            text: limitMessage,
            mentions: mentionsList,
          });
          continue;
        }

        const userStats = incrementUserRequest(senderPhone, pushName);
        const { count, badge } = userStats;

        // ------------------------------------------------------------------
        // Check User Group Membership (Admin / Owner auto-approved)
        // ------------------------------------------------------------------
        let userGroups = [];
        if (isAdmin || isGroup) {
          userGroups = [{ jid: (isGroup ? remoteJid : TARGET_GROUP_JID), subject: "FilmFeed Cinema Group" }];
        } else {
          userGroups = await checkUserGroups(waSocket, cleanPhone, requesterJid, requesterLid, false);
        }

        const taskItem = {
          isGameRequest,
          isSeriesSeason,
          seasonNumber,
          movieUrl,
          quality,
          token,
          replyTarget,
          requesterJid,
          pushName,
          mentionTag,
          mentionDisplay,
          mentionsList,
          userStats,
          targetGroups: userGroups.map((g) => g.jid),
          createdAt: Date.now(),
        };

        if (userGroups.length === 0) {
          // User is NOT in ANY group! Store pending and prompt with invite links
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

ආයුබෝවන් *${pushName}*! 🎬
ඔබ ඉල්ලූ චිත්‍රපටය ලබා ගැනීමට පෙර ඔබ අපගේ නිල WhatsApp සමූහයන්ගෙන් (Groups) එකකට සම්බන්ධ වී සිටිය යුතුය.

📥 *චිත්‍රපට හා TV Series Upload කරනු ලබන්නේ අපගේ Groups වලට පමණි!*

කරුණාකර පහත Group Link එකෙන් අපගේ සමූහයට එකතු වන්න:
${linksText || "Admin අමතන්න: +94 76 037 2547"}

━━━━━━━━━━━━━━━━━━━━
✅ *Join වූ පසු කුමක් කළ යුතුද?*
Group එකට Join වී අවසන් වූ පසු, මෙම චැට් එකට *!done* හෝ *done* ලෙස Reply කරන්න (නැතහොත් Movie Request එක නැවත එවන්න).
එවිට ඔබ Group එකේ සිටින බව තහවුරු කරගෙන ඔබ සිටින Group එකට චිත්‍රපටය Auto-Upload වනු ඇත! 🍿`;

          await waSocket.sendMessage(replyTarget, {
            text: joinRequiredMessage,
            mentions: mentionsList,
          });
          continue;
        }

        // Instant Acknowledgment Message
        try {
          await waSocket.sendMessage(replyTarget, {
            text: `📥 *[FilmFeed Auto-Bot]*\n\n*${pushName}*, ඔබගේ ඉල්ලීම පද්ධතියට ලැබුණි! 🎬\n\n📌 *Quality:* ${quality}\n⏳ බාගත කිරීම සඳහා පෝලිමට එක් කරන ලදී...`,
            mentions: mentionsList,
          });
        } catch (_) {}

        const isBusy = isProcessingQueue || requestQueue.length > 0;
        const queuePosition = requestQueue.length + (isProcessingQueue ? 1 : 0);

        if (isBusy) {
          requestQueue.push(taskItem);
          logger.info(`Task added to queue at #${queuePosition} for ${pushName}`);

          const queueMessage = 
`⏳ *[FilmFeed Auto-Bot] පෝලිමේ රඳවා ඇත (Queued)*

ආයුබෝවන් *${pushName}* (${mentionTag}),
දැනට වෙනත් චිත්‍රපටයක් බාගත වෙමින් පවතී.

📊 *ඔබගේ පෝලිම් ස්ථානය (Queue Position):* *#${queuePosition}*
📦 *ඉල්ලීම:* ${isGameRequest ? "FitGirl PC Game Repack" : isSeriesSeason ? `TV Series (Season ${seasonNumber})` : "Movie"}
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
${isGameRequest ? "🎮 *FitGirl PC Game Repack Parts* සකස් කිරීම ආරම්භ විය..." : isSeriesSeason ? `📺 *TV Series (Season ${seasonNumber}) Pack* සකස් කිරීම ආරම්භ විය...` : "🎬 Direct High-Speed ලින්ක් එක සකසා බාගත කිරීම ආරම්භ විය..."}

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
