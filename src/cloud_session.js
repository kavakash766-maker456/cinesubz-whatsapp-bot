const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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
    if (!this.token) return null;
    try {
      const res = await fetch("https://api.github.com/gists?per_page=30", {
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        console.warn(`[CloudSession] Failed to fetch gists: HTTP ${res.status}`);
        return null;
      }
      const gists = await res.json();
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

      const res = await fetch(`https://api.github.com/gists/${this.gistId}`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        console.warn(`[CloudSession] Failed to read gist ${this.gistId}: HTTP ${res.status}`);
        return false;
      }

      const data = await res.json();
      const fileObj = data.files[GIST_FILENAME];
      if (!fileObj || !fileObj.content) {
        console.warn("[CloudSession] Vault file is empty.");
        return false;
      }

      const compressed = Buffer.from(fileObj.content, "base64");
      const unzipped = zlib.gunzipSync(compressed).toString("utf8");
      const files = JSON.parse(unzipped);

      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      let restoredCount = 0;
      for (const [fname, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(this.authDir, fname), content, "utf8");
        restoredCount++;
      }

      console.log(`✅ [CloudSession] Successfully restored ${restoredCount} session files from Private Cloud Vault!`);
      return true;
    } catch (err) {
      console.warn(`⚠️ [CloudSession] Restore failed: ${err.message}`);
      return false;
    }
  }

  scheduleSync() {
    if (!this.token) return;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.sync().catch((e) => console.warn(`[CloudSession] Background sync error: ${e.message}`));
    }, 4000); // Debounce by 4s
  }

  async sync() {
    if (!this.token || this.isSyncing) return;
    this.isSyncing = true;

    try {
      if (!fs.existsSync(this.authDir)) return;
      const fileNames = fs.readdirSync(this.authDir).filter((f) => f.endsWith(".json"));
      if (fileNames.length === 0 || !fs.existsSync(path.join(this.authDir, "creds.json"))) {
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
        // Update existing gist
        const res = await fetch(`https://api.github.com/gists/${this.gistId}`, {
          method: "PATCH",
          headers: this.getHeaders(),
          body: JSON.stringify({
            description: GIST_DESC,
            files: {
              [GIST_FILENAME]: {
                content: base64Content,
              },
            },
          }),
        });
        if (res.ok) {
          console.log(`☁️ [CloudSession] Synced ${fileNames.length} auth files to private cloud vault.`);
        } else {
          console.warn(`[CloudSession] Failed to update gist: HTTP ${res.status}`);
        }
      } else {
        // Create new private gist
        const res = await fetch("https://api.github.com/gists", {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            description: GIST_DESC,
            public: false,
            files: {
              [GIST_FILENAME]: {
                content: base64Content,
              },
            },
          }),
        });
        if (res.ok) {
          const created = await res.json();
          this.gistId = created.id;
          console.log(`☁️ [CloudSession] Created new private cloud vault (id: ${this.gistId}) and synced session.`);
        } else {
          console.warn(`[CloudSession] Failed to create gist: HTTP ${res.status}`);
        }
      }
    } catch (err) {
      console.warn(`[CloudSession] Sync failed: ${err.message}`);
    } finally {
      this.isSyncing = false;
    }
  }
}

module.exports = CloudSession;
