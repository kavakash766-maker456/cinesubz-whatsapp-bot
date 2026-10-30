const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const https = require("https");
const dns = require("dns");
const axios = require("axios");

try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });
const GIST_FILENAME = "session_vault.json";

class CloudSession {
  constructor(authDir, token, gistId = null, gistDesc = null) {
    this.authDir = authDir;
    this.token = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GH_PAT;
    this.gistId = gistId || process.env.SESSION_VAULT_ID || null;
    this.gistDesc = gistDesc || process.env.SESSION_VAULT_DESC || "filmfeed-whatsapp-auth-vault-v1";
    this.isSyncing = false;
    this.syncTimeout = null;
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "FilmFeed-Bot-SessionSync",
    };
  }

  async findGist() {
    if (this.gistId) return { id: this.gistId };
    if (!this.token) return null;
    try {
      const res = await axios.get("https://api.github.com/gists?per_page=50", {
        headers: this.getHeaders(),
        httpsAgent: ipv4Agent,
        timeout: 10000,
      });
      const gists = res.data;
      const match = gists.find(
        (g) => g.description === this.gistDesc && g.files && g.files[GIST_FILENAME]
      );
      if (match) {
        this.gistId = match.id;
        return match;
      }
    } catch (err) {
      console.warn(`[CloudSession] Error finding gist (${this.gistDesc}): ${err.message}`);
    }
    return null;
  }

  async restore() {
    if (!this.token) {
      console.log("[CloudSession] No GitHub token provided; skipping cloud restore.");
      return false;
    }

    if (
      process.env.RESET_SESSION === "true" ||
      process.env.FORCE_NEW_QR === "true" ||
      process.env.RESET_BOT === "true" ||
      (this.gistDesc.includes("series") && process.env.RESET_SERIES_BOT === "true") ||
      (!this.gistDesc.includes("series") && process.env.RESET_MOVIE_BOT === "true")
    ) {
      console.log(`🔄 [CloudSession] RESET requested: Skipping restore for ${this.gistDesc} to generate fresh QR!`);
      return false;
    }

    try {
      console.log(`[CloudSession] Searching for existing WhatsApp session in vault (${this.gistDesc})...`);
      let contentStr = null;

      // 1. Direct Fast Raw URL (instant ~300ms, avoids Gist API truncation & JSON overhead)
      if (this.gistId) {
        try {
          const directRawUrl = `https://gist.githubusercontent.com/raw/${this.gistId}/${GIST_FILENAME}`;
          const rawRes = await axios.get(directRawUrl, {
            headers: this.getHeaders(),
            httpsAgent: ipv4Agent,
            timeout: 30000,
          });
          if (rawRes.data && typeof rawRes.data === "string" && rawRes.data.length > 500) {
            contentStr = rawRes.data;
            console.log(`[CloudSession] Direct raw vault fetched successfully (${contentStr.length} bytes).`);
          }
        } catch (rawErr) {
          console.warn(`[CloudSession] Direct raw fetch fallback: ${rawErr.message}`);
        }
      }

      // 2. Fallback to GitHub Gist REST API
      if (!contentStr) {
        const gist = await this.findGist();
        if (!gist) {
          console.log(`[CloudSession] No existing cloud session found for ${this.gistDesc}. Fresh QR will be generated.`);
          return false;
        }

        const res = await axios.get(`https://api.github.com/gists/${this.gistId}`, {
          headers: this.getHeaders(),
          httpsAgent: ipv4Agent,
          timeout: 30000,
        });
        
        const data = res.data;
        const fileObj = data.files[GIST_FILENAME];
        if (!fileObj) {
          console.warn("[CloudSession] Vault file missing in Gist.");
          return false;
        }

        contentStr = fileObj.content;
        if ((fileObj.truncated || !contentStr) && fileObj.raw_url) {
          console.log("[CloudSession] Content truncated in API; fetching full vault from raw_url...");
          const rawRes = await axios.get(fileObj.raw_url, {
            headers: this.getHeaders(),
            httpsAgent: ipv4Agent,
            timeout: 30000,
          });
          contentStr = typeof rawRes.data === "string" ? rawRes.data : JSON.stringify(rawRes.data);
        }
      }

      if (!contentStr) {
        console.warn("[CloudSession] Vault content is empty.");
        return false;
      }

      // Check if vault was explicitly cleared/invalidated
      if (contentStr.includes('"invalid":true') || contentStr.startsWith("{")) {
        console.log("[CloudSession] Vault was previously cleared or marked invalid; skipping restore to generate fresh QR.");
        return false;
      }

      let files = null;
      try {
        const compressed = Buffer.from(contentStr, "base64");
        const unzipped = zlib.gunzipSync(compressed).toString("utf8");
        files = JSON.parse(unzipped);
      } catch (err) {
        console.log(`[CloudSession] Could not unpack vault (${err.message}); skipping restore to generate fresh QR.`);
        return false;
      }

      const credsObj = files["creds.json"] ? JSON.parse(files["creds.json"]) : null;
      const isValidAuth = Boolean(
        credsObj &&
        (credsObj.registered === true || (credsObj.me && credsObj.me.id))
      );

      if (!isValidAuth) {
        console.log("[CloudSession] Cloud vault does not contain authenticated credentials; skipping restore to generate fresh QR.");
        return false;
      }

      if (credsObj.me && credsObj.me.id) {
        credsObj.registered = true;
        files["creds.json"] = JSON.stringify(credsObj, null, 2);
      }

      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      let restoredCount = 0;
      for (const [fname, fcontent] of Object.entries(files)) {
        if (typeof fcontent === "string") {
          fs.writeFileSync(path.join(this.authDir, fname), fcontent, "utf8");
          restoredCount++;
        }
      }

      const linkedAccount = credsObj.me?.id || "Registered User";
      console.log(`✅ [CloudSession] Successfully restored ${restoredCount} session files from vault (${this.gistDesc})! (Linked to: ${linkedAccount})`);
      return true;
    } catch (err) {
      console.warn(`[CloudSession] Restore notice: ${err.message}`);
      return false;
    }
  }

  async clearVault() {
    if (!this.token) return;
    try {
      await this.findGist();
      if (this.gistId) {
        await axios.patch(`https://api.github.com/gists/${this.gistId}`, {
          description: this.gistDesc,
          files: {
            [GIST_FILENAME]: {
              content: '{"invalid":true}',
            },
          },
        }, {
          headers: this.getHeaders(),
          httpsAgent: ipv4Agent,
          timeout: 10000,
        });
        console.log(`🧹 [CloudSession] Cleared cloud session vault (${this.gistDesc}).`);
      }
    } catch (e) {
      console.warn(`[CloudSession] clearVault warning: ${e.message}`);
    }
  }

  scheduleSync() {
    if (!this.token) return;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.sync().catch((e) => console.warn(`[CloudSession] Background sync error: ${e.message}`));
    }, 2000);
  }

  async sync() {
    if (!this.token || this.isSyncing) return;
    this.isSyncing = true;

    try {
      if (!fs.existsSync(this.authDir)) return;
      const credsPath = path.join(this.authDir, "creds.json");
      if (!fs.existsSync(credsPath)) return;

      let credsData = null;
      try {
        credsData = JSON.parse(fs.readFileSync(credsPath, "utf8"));
      } catch (err) {
        console.warn(`[CloudSession] Error reading creds.json: ${err.message}`);
        return;
      }

      const isValidAuth = Boolean(
        credsData &&
        (credsData.registered === true || (credsData.me && credsData.me.id))
      );

      if (!isValidAuth) {
        return;
      }

      if (credsData.me && credsData.me.id && credsData.registered !== true) {
        credsData.registered = true;
        try {
          fs.writeFileSync(credsPath, JSON.stringify(credsData, null, 2), "utf8");
        } catch (_) {}
      }

      const fileNames = fs.readdirSync(this.authDir).filter((f) => f.endsWith(".json"));
      if (fileNames.length === 0) {
        return;
      }

      const files = {};
      for (const fname of fileNames) {
        files[fname] = fs.readFileSync(path.join(this.authDir, fname), "utf8");
      }

      const jsonStr = JSON.stringify(files);
      const zipped = zlib.gzipSync(Buffer.from(jsonStr, "utf8"));
      const base64Content = zipped.toString("base64");

      if (!this.gistId) {
        await this.findGist();
      }

      if (this.gistId) {
        await axios.patch(`https://api.github.com/gists/${this.gistId}`, {
          description: this.gistDesc,
          files: {
            [GIST_FILENAME]: {
              content: base64Content,
            },
          },
        }, {
          headers: this.getHeaders(),
          httpsAgent: ipv4Agent,
          timeout: 20000,
        });
        console.log(`☁️ [CloudSession] Synced ${fileNames.length} auth files to vault (${this.gistDesc}).`);
      } else {
        const createdRes = await axios.post("https://api.github.com/gists", {
          description: this.gistDesc,
          public: false,
          files: {
            [GIST_FILENAME]: {
              content: base64Content,
            },
          },
        }, {
          headers: this.getHeaders(),
          httpsAgent: ipv4Agent,
          timeout: 20000,
        });
        this.gistId = createdRes.data.id;
        console.log(`☁️ [CloudSession] Created new private cloud vault for ${this.gistDesc} (id: ${this.gistId}).`);
      }
    } catch (err) {
      console.warn(`[CloudSession] Sync failed (${this.gistDesc}): ${err.message}`);
    } finally {
      this.isSyncing = false;
    }
  }
}

module.exports = CloudSession;
