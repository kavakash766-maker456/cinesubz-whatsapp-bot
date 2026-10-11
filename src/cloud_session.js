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
const GIST_DESC = "filmfeed-whatsapp-auth-vault-v1";
const GIST_FILENAME = "session_vault.json";

class CloudSession {
  constructor(authDir, token) {
    this.authDir = authDir;
    this.token = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    this.gistId = null;
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
    const directVaultId = process.env.SESSION_VAULT_ID || "8f37b6dbcf07ff6fab07b21cc8cbe05b";
    if (directVaultId) {
      this.gistId = directVaultId;
      return { id: directVaultId };
    }
    if (!this.token) return null;
    try {
      const res = await axios.get("https://api.github.com/gists?per_page=30", {
        headers: this.getHeaders(),
        httpsAgent: ipv4Agent,
        timeout: 10000,
      });
      const gists = res.data;
      const match = gists.find(
        (g) => g.description === GIST_DESC && g.files && g.files[GIST_FILENAME]
      );
      if (match) {
        this.gistId = match.id;
        return match;
      }
    } catch (err) {
      console.warn(`[CloudSession] Error finding gist: ${err.message}`);
    }
    return null;
  }

  async restore() {
    if (!this.token) {
      console.log("[CloudSession] No GitHub token provided; skipping cloud restore.");
      return false;
    }

    try {
      console.log("[CloudSession] Searching for existing WhatsApp session in private GitHub vault...");
      const gist = await this.findGist();
      if (!gist) {
        console.log("[CloudSession] No existing cloud session found in private vault.");
        return false;
      }

      const res = await axios.get(`https://api.github.com/gists/${this.gistId}`, {
        headers: this.getHeaders(),
        httpsAgent: ipv4Agent,
        timeout: 15000,
      });
      
      const data = res.data;
      const fileObj = data.files[GIST_FILENAME];
      if (!fileObj) {
        console.warn("[CloudSession] Vault file missing in Gist.");
        return false;
      }

      let contentStr = fileObj.content;
      if (!contentStr && fileObj.raw_url) {
        console.log("[CloudSession] Content truncated in API; fetching from raw_url...");
        const rawRes = await axios.get(fileObj.raw_url, {
          headers: this.getHeaders(),
          httpsAgent: ipv4Agent,
          timeout: 25000,
        });
        contentStr = typeof rawRes.data === "string" ? rawRes.data : JSON.stringify(rawRes.data);
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
      for (const [fname, content] of Object.entries(files)) {
        if (fname.startsWith("session-") || fname.startsWith("sender-key-")) continue;
        fs.writeFileSync(path.join(this.authDir, fname), content, "utf8");
        restoredCount++;
      }

      console.log(`✅ [CloudSession] Successfully restored ${restoredCount} session files from Private Cloud Vault! (Linked to: ${credsObj.me?.id || "Registered User"})`);
      return true;
    } catch (err) {
      console.warn(`⚠️ [CloudSession] Restore failed: ${err.message}`);
      return false;
    }
  }

  async clearVault() {
    if (!this.token) return;
    try {
      if (!this.gistId) await this.findGist();
      if (this.gistId) {
        await axios.patch(`https://api.github.com/gists/${this.gistId}`, {
          description: GIST_DESC,
          files: {
            [GIST_FILENAME]: {
              content: JSON.stringify({ invalid: true, cleared_at: new Date().toISOString() }),
            },
            "latest_qr.txt": {
              content: "Awaiting new QR generation...",
            },
          },
        }, {
          headers: this.getHeaders(),
          httpsAgent: ipv4Agent,
          timeout: 15000,
        });
        console.log("🗑️ [CloudSession] Revoked/expired session cleared from Private Cloud Vault.");
      }
    } catch (err) {
      console.warn(`[CloudSession] Failed to clear vault: ${err.message}`);
    }
  }

  scheduleSync() {
    if (!this.token) return;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.sync().catch((e) => console.warn(`[CloudSession] Background sync error: ${e.message}`));
    }, 4000);
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
        console.log("[CloudSession] Session not authenticated yet; skipping cloud vault sync.");
        return;
      }

      if (credsData.me && credsData.me.id && credsData.registered !== true) {
        credsData.registered = true;
        try {
          fs.writeFileSync(credsPath, JSON.stringify(credsData, null, 2), "utf8");
        } catch (_) {}
      }

      const fileNames = fs.readdirSync(this.authDir).filter((f) => {
        if (!f.endsWith(".json")) return false;
        // Never sync ephemeral chat sessions or group sender keys.
        // Stale sessions from prior runs cause permanent "Bad MAC" signal decryption errors.
        if (f.startsWith("session-") || f.startsWith("sender-key-")) return false;
        return true;
      });
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
          description: GIST_DESC,
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
        console.log(`☁️ [CloudSession] Synced ${fileNames.length} auth files to private cloud vault.`);
      } else {
        const createdRes = await axios.post("https://api.github.com/gists", {
          description: GIST_DESC,
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
        console.log(`☁️ [CloudSession] Created new private cloud vault (id: ${this.gistId}) and synced session.`);
      }
    } catch (err) {
      console.warn(`[CloudSession] Sync failed: ${err.message}`);
    } finally {
      this.isSyncing = false;
    }
  }
}

module.exports = CloudSession;
