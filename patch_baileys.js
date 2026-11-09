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

  // 4. Ensure generous 10-minute timeout for heavy document uploads
  if (!content.includes("timeout: timeoutMs || 600000")) {
    content = content.replace(
      /timeout:\s*timeoutMs\s*,/g,
      "timeout: timeoutMs || 600000,"
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(targetFile, content, 'utf-8');
    console.log('[PatchBaileys] Successfully patched messages-media.js with Content-Length, finish-sync, and 600s timeout!');
  } else {
    console.log('[PatchBaileys] Baileys messages-media.js is already fully patched.');
  }
  return true;
}

if (require.main === module) {
  patchBaileys();
}

module.exports = patchBaileys;
