const axios = require("axios");
const crypto = require("crypto");
const CryptoJS = require("crypto-js");
const protobuf = require("protobufjs");

async function resolveCsPlayer(driveUrl) {
  if (!driveUrl || !driveUrl.includes("csplayer")) {
    return { success: false, error: "Not a csplayer URL" };
  }

  const urlObj = new URL(driveUrl);
  const host = `${urlObj.protocol}//${urlObj.host}`;
  const path = urlObj.pathname;

  const client = axios.create({
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://cinesubz.lk/",
    },
    timeout: 15000,
    withCredentials: true,
  });

  // 1. Warmup visit to obtain cookies
  let cookies = [];
  try {
    const r1 = await client.get(driveUrl);
    if (r1.headers["set-cookie"]) {
      cookies = r1.headers["set-cookie"].map((c) => c.split(";")[0]);
    }
  } catch (_) {}

  const cookieHeader = cookies.join("; ");

  // 2. Query download data endpoint
  let redirect = "";
  try {
    const r2 = await client.get(`${host}/api/download-data${path}`, {
      headers: {
        Accept: "application/json",
        Referer: driveUrl,
        Cookie: cookieHeader,
      },
    });
    redirect = r2.data?.redirect;
  } catch (e) {
    return { success: false, error: `API download-data failed: ${e.message}` };
  }

  if (!redirect) {
    return { success: false, error: "No redirect path in API response" };
  }

  const target = `${host}${redirect}`;

  // 3. Fetch redirect download page
  let pageHtml = "";
  try {
    const r3 = await client.get(target, {
      headers: {
        Referer: `${host}/`,
        Cookie: cookieHeader,
      },
    });
    pageHtml = r3.data;
  } catch (e) {
    return { success: false, error: `Failed to fetch target page: ${e.message}` };
  }

  // 4. Extract script containing probe and unpack logic
  const scripts = pageHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  let scriptContent = "";
  for (const s of scripts) {
    const inner = s.replace(/<script[^>]*>|<\/script>/gi, "");
    if (inner.includes("csProbe") && inner.includes("hexToBytes")) {
      scriptContent = inner;
      break;
    }
  }

  if (!scriptContent) {
    return { success: false, error: "Target script not found in page" };
  }

  // 5. Build isolated sandbox to calculate probe and unpack function
  const unpackMatch = scriptContent.match(/=\s*(_[a-f0-9]{10})\(new Uint8Array/);
  const unpackFuncName = unpackMatch ? unpackMatch[1] : null;

  const mockEnv = `
    const crypto = require('crypto');
    const CryptoJS = require('crypto-js');
    const protobuf = require('protobufjs');
    const window = { addEventListener: () => {} };
    const document = { addEventListener: () => {}, getElementById: () => null, querySelector: () => null };
    const navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', platform: 'Win32' };
    const sessionStorage = { getItem: () => '[]', setItem: () => {} };
    const performance = { now: () => 3500, getEntriesByType: () => [] };
  `;

  // Neutralize bot checks to ensure clean probe
  const modifiedScript = scriptContent.replace(
    /function csBits\(\)\s*\{/,
    "function csBits(){ return 0; "
  );

  let csProbe = null;
  let unpackFn = null;

  try {
    const evalEnv = {
      require,
      Buffer,
      Uint8Array,
      console,
    };
    const sandboxFunc = new Function(
      "require",
      "Buffer",
      "Uint8Array",
      `${mockEnv}\n${modifiedScript}\nreturn { csProbe: (typeof csProbe === 'function' ? csProbe : null), unpack: (typeof ${unpackFuncName} === 'function' ? ${unpackFuncName} : null) };`
    );
    const mod = sandboxFunc(require, Buffer, Uint8Array);
    csProbe = mod.csProbe;
    unpackFn = mod.unpack;
  } catch (evalErr) {
    return { success: false, error: `Sandbox evaluation error: ${evalErr.message}` };
  }

  if (!csProbe) {
    return { success: false, error: "Failed to initialize csProbe in sandbox" };
  }

  const probe = csProbe();

  // 6. Extract hex payloads from page
  const payloads = [];
  const payloadMatches = pageHtml.matchAll(/'([0-9a-f]{300,})'/g);
  for (const m of payloadMatches) {
    if (!payloads.includes(m[1])) {
      payloads.push(m[1]);
    }
  }

  let directUrl = null;
  let telegramFallback = null;

  // 7. Test payloads to find valid 200 response
  for (const hexPayload of payloads) {
    try {
      const postBody = Buffer.from(hexPayload, "hex");
      const postRes = await client.post(target, postBody, {
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CS-T": probe,
          Referer: target,
          Origin: host,
          Cookie: cookieHeader,
        },
        responseType: "arraybuffer",
      });

      if (postRes.status === 200 && postRes.data && postRes.data.length > 20) {
        if (unpackFn) {
          try {
            const rawUint8 = new Uint8Array(postRes.data);
            const resolved = unpackFn(rawUint8);
            if (resolved && typeof resolved === "string") {
              if (
                resolved.includes("r2.cloudflarestorage.com") ||
                resolved.includes("pixeldrain.com") ||
                resolved.includes(".mp4") ||
                resolved.includes("supercloud")
              ) {
                directUrl = resolved;
                break;
              } else if (resolved.includes("t.me") || resolved.includes("telegram.me")) {
                telegramFallback = resolved;
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  const finalUrl = directUrl || telegramFallback;
  if (finalUrl) {
    return {
      success: true,
      direct_url: finalUrl,
      is_direct: Boolean(directUrl),
      is_telegram: !directUrl && Boolean(telegramFallback),
    };
  }

  return { success: false, error: "No direct download stream could be unlocked from csplayer" };
}

if (require.main === module) {
  const targetUrl = process.argv[2];
  if (!targetUrl) {
    console.log(JSON.stringify({ success: false, error: "No URL provided" }));
    process.exit(1);
  }
  resolveCsPlayer(targetUrl).then((res) => {
    console.log(JSON.stringify(res, null, 2));
  });
}

module.exports = { resolveCsPlayer };
