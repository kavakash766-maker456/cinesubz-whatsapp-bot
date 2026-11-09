const fs = require('fs');
const path = require('path');

function patchBaileys() {
  const possiblePaths = [
    path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js'),
    path.join(__dirname, '../node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js'),
    path.join(process.cwd(), 'node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js'),
    path.join(process.cwd(), 'bot/node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js'),
  ];

  let targetFile = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      targetFile = p;
      break;
    }
  }

  if (!targetFile) {
    console.log('[PatchBaileys] Target file not found, skipping patch.');
    return false;
  }

  let content = fs.readFileSync(targetFile, 'utf-8');
  let modified = false;

  // 1. Ensure statSync is imported
  if (!content.includes('statSync')) {
    content = content.replace(
      /import\s*\{\s*createReadStream\s*,\s*createWriteStream\s*,/g,
      "import { statSync, createReadStream, createWriteStream,"
    );
    modified = true;
  }

  // 2. Inject Content-Length directly into the axios.post headers
  if (!content.includes("'Content-Length': String(statSync(filePath).size)")) {
    content = content.replace(
      /'Content-Type':\s*'application\/octet-stream',/g,
      "'Content-Type': 'application/octet-stream',\n                        'Content-Length': String(statSync(filePath).size),"
    );
    modified = true;
  }

  // 3. Ensure encFileWriteStream finishes completely before returning
  if (!content.includes("await once(encFileWriteStream, 'finish');")) {
    content = content.replace(
      /encFileWriteStream\.end\(\);\s*\r?\n\s*originalFileStream\?\.end\?\.\(\);/g,
      "encFileWriteStream.end();\n        await once(encFileWriteStream, 'finish');\n        originalFileStream?.end?.();"
    );
    modified = true;
  }

  // 4. Force fresh mediaConn auth token before MMS upload
  if (content.includes("refreshMediaConn(false)")) {
    content = content.replace(/refreshMediaConn\(false\)/g, "refreshMediaConn(true)");
    modified = true;
  }

  // 5. Ensure generous 30-minute timeout (1800000ms) for heavy document uploads
  if (!content.includes("timeout: timeoutMs || 1800000")) {
    content = content.replace(
      /timeout:\s*(?:timeoutMs\s*\|\|\s*600000|timeoutMs)\s*,/g,
      "timeout: timeoutMs || 1800000,"
    );
    modified = true;
  }

  // 6. Inject global.__waMediaUploadProgress hook into axios.post
  if (!content.includes("global.__waMediaUploadProgress")) {
    const postSearch = /responseType:\s*'json',/g;
    content = content.replace(
      postSearch,
      `responseType: 'json',
                    onUploadProgress: (progressEvent) => {
                        try {
                            if (typeof global.__waMediaUploadProgress === 'function') {
                                global.__waMediaUploadProgress(progressEvent);
                            }
                        } catch (_) {}
                    },`
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(targetFile, content, 'utf-8');
    console.log('[PatchBaileys] Successfully patched messages-media.js with Content-Length, fresh mediaConn, 1800s timeout, and progress hook!');
  } else {
    console.log('[PatchBaileys] Baileys messages-media.js is already fully patched.');
  }
  return true;
}

if (require.main === module) {
  patchBaileys();
}

module.exports = patchBaileys;
