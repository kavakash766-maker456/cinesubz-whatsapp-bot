const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const serviceAccount = {
  project_id: "taskbounty-9aa8e",
  client_email: "firebase-adminsdk-fbsvc@taskbounty-9aa8e.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCpRdL+kvv5j7Hf\ndJYz1FzRk7h98K4/HOjeKZRJlHNpjOsSEe78Y6Yavl03erJxdldZpGJ5W0eOR5uI\ngPsWLD+9CyTIEsNFOtb/QUc83n57JPoY6vwAzN/qj7d39CrqRvXohnh2Cv0J+VwP\nuaaYGiMepGk3K7r2e81+v+FPBfbM9cD4NuuKFPJK2gzmxtrSiRm4pbVrOA/qtQIt\nfkgfUFpF0OMqwCruDIth+IkXtdxC1I2+WHO/l0p9wgMPNqLhOry0ETvwpEzh+AOr\nhnFUH8cw4pkGpMOe7pfFb8DGrWdcI3wsSWDyyMNHNyz7q3wgqxwPPnEssh6Qwrt3\nrjdqWwhrAgMBAAECggEAKTWhh26bP4d3I1KL2rRhoHgZGzgEA8NzAdsXic5FRrYS\n6IRLLVDJOIuNwBrz5GGOJHm7q5XIVuAiAlp8RkqhfdF/s+G1fl4zx1LKGAyGuE4p\nQPW8QimefcldPivIYt7BsUlDfGFydwIpIn7tCuyaDjSylMblrmo3fhsSrB1kl0L7\ngaUqo6j68svMFSHvRXMIJrkyYVik6murtV0N/IQFI/c+brkfKGb+h901ZhuR5z9H\nBdmk5XB5xC6Yfq9D1moNbaGzLQXcOlAzqJR3SEcZ/RJnpqsRz99sZvxDoZT44Mkv\nDl/XDvFX5n+JdXXERTxFBvpmFRVxgAMVvFdF6xUbkQKBgQDgaNnaFzb59rc9yFEB\n5iiTqUEE1q4aJfpET5M22xyLyPCLkFr4KfYrOnKpjw8/5OpFiafwsnwIufJtfiuf\nY7UZjN+1ocbgjdsG4Rtm306FHPOrkSHg+anBN0Ww0yWB1WD8EUvyne7AO8VNJE2R\ntKEgdFDGlwIKlyoE8g7cUQ2GmQKBgQDBGfuOrwa/OkZ6tOpL4WnR+Tq655JxlnIm\nxPSwXFmlgj7LIOikUzEC93Cb8lcv79OfO4eyerBQFSdja8pDXwGGNndjYdyd69hY\nzAVI7JJ0BggrxvHcnRDpYsBlL3tXh+n9cOWxe9nSZf8aseG/Li0mSAAVznqniOLc\njuFgnNcdowKBgQCiS5JKhQGQk9qARzA25GKyL/VC75Poe1DdOIOqZ5rkiYVWGieA\nVLChINsuP7Vyqza25dBcZmkH0ps+jsIzuuONv/FGpeJ0IoOmHQU5SAS8hmy/xu2u\njEE16KhxMrNsi4phooy/wXKa+l895CRpXS4uj5CfnzStvhd4jisrMT9L+QKBgBj3\nG//ZfxzQEvagVz5SOVUtTLuHXvaShdWfVydJ+UkdqrKmYY2FN+vzQ7rVvRH0hr6q\neqPHmu3vnjULZY4KRW8tsYfGyjgcms74KaLA+zpG4V2PjguAvwP9gXRTjDXH26ep\npfipU4MRLscrwkzuUmYFnwUyucbZOsNbMaZFAMbTAoGAf795lnOJ80TgRkmL9Rwn\nYcIz5WTdB3s6YIJR3hD0hx75VASBtTF6MUDk2qTXCUpZ0LtC1xDngRUJXMUzsUd+\nEhWIi2zcIsKwrqZvjOQRzLkKztDZyDzEvngb1ehvS12p7lluWGkZhAhCLoKKT18q\nGM6922geCW7WfwZtJHq7DpA=\n-----END PRIVATE KEY-----\n"
};

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpiresAt > now + 300) {
    return cachedToken;
  }

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sigInput = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(sigInput);
  const sig = sign.sign(serviceAccount.private_key, "base64url");
  const jwt = sigInput + "." + sig;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(jwt)
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || "Failed to get Google Access Token");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600);
  return cachedToken;
}

/**
 * Register or update bot session in Firestore
 */
async function registerBotInFirestore(phone, name, status = "ONLINE", channelFollowed = true) {
  try {
    const token = await getAccessToken();
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const url = `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/linked_bots/${cleanPhone}`;

    const body = {
      fields: {
        phone: { stringValue: cleanPhone },
        name: { stringValue: name || "FilmFeed User" },
        status: { stringValue: status },
        channelFollowed: { booleanValue: Boolean(channelFollowed) },
        lastPing: { stringValue: new Date().toISOString() }
      }
    };

    await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    console.log(`📡 [Firebase] Synced bot session for +${cleanPhone} -> Status: ${status}`);
    return true;
  } catch (err) {
    console.warn(`[Firebase] Sync error for ${phone}:`, err.message);
    return false;
  }
}

module.exports = {
  getAccessToken,
  registerBotInFirestore
};
