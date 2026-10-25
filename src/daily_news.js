const axios = require("axios");
const path = require("path");
const fs = require("fs");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "b6524bb48fb309af7e940a074a363851";
const OFFICIAL_CHANNEL_URL = "https://whatsapp.com/channel/0029Vb9AG1c3GJOsPvzqdu0R";
const POSTED_CACHE_FILE = path.join(__dirname, "../data/posted_news.json");

// Ensure data folder exists
const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function getPostedMovies() {
  try {
    if (fs.existsSync(POSTED_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(POSTED_CACHE_FILE, "utf8"));
    }
  } catch (_) {}
  return [];
}

function savePostedMovie(id) {
  try {
    const list = getPostedMovies();
    list.push(id);
    if (list.length > 50) list.shift();
    fs.writeFileSync(POSTED_CACHE_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (_) {}
}

/**
 * Fetch top trending movie of the day from TMDb
 */
async function fetchTrendingCinemaNews() {
  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/trending/movie/day?api_key=${TMDB_API_KEY}&language=en-US`,
      { timeout: 10000 }
    );
    const results = res.data?.results || [];
    if (results.length === 0) return null;

    const postedIds = getPostedMovies();
    // Pick the first one that hasn't been posted yet, or fallback to the top 1
    const movie = results.find((m) => !postedIds.includes(m.id)) || results[0];

    // Fetch genre names
    const genresRes = await axios.get(
      `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-US`,
      { timeout: 8000 }
    ).catch(() => null);

    const genreMap = {};
    genresRes?.data?.genres?.forEach((g) => {
      genreMap[g.id] = g.name;
    });

    const genres = (movie.genre_ids || [])
      .map((gid) => genreMap[gid])
      .filter(Boolean)
      .join(", ") || "Action, Drama";

    const posterUrl = movie.poster_path
      ? `https://image.tmdb.org/t/p/w780${movie.poster_path}`
      : (movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : null);

    return {
      id: movie.id,
      title: movie.title || movie.original_title,
      overview: movie.overview || "Exciting cinema release now trending worldwide.",
      rating: movie.vote_average ? movie.vote_average.toFixed(1) : "7.8",
      releaseDate: movie.release_date || new Date().toISOString().slice(0, 10),
      genres,
      posterUrl,
    };
  } catch (err) {
    console.error("[DailyNews] Error fetching TMDb trending:", err.message);
    return null;
  }
}

/**
 * Translate & synthesize synopsis into attractive Sinhala cinema news
 */
async function generateSinhalaSynopsis(title, overview, genres) {
  try {
    const prompt = `Write a short, exciting 2-3 sentence summary in natural, engaging Sinhala about the movie "${title}" (${genres}). Context in English: "${overview}". Do not add English words, only clean fluent Sinhala cinema review style.`;
    const aiUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`)}`;
    const aiRes = await axios.get(aiUrl, { timeout: 15000 });
    if (aiRes.data && typeof aiRes.data === "string" && aiRes.data.length > 20) {
      return aiRes.data.trim();
    }
  } catch (_) {}

  // High quality manual fallback in Sinhala
  return `ලොව පුරා සිනමා රසිකයන්ගේ දැඩි අවධානය දිනාගත් ${title} චිත්‍රපටය මේ වන විට අතිශය ජනප්‍රියත්වයට පත්ව ඇත. උසස් ගණයේ සිනමා අත්දැකීමක් සහිත මෙම නිර්මාණය නරඹන්නන් අතර ඉහළ ප්‍රතිචාර ලබමින් සිටී.`;
}

/**
 * Formats the complete viral WhatsApp Channel news update
 */
async function buildChannelNewsPost() {
  const movie = await fetchTrendingCinemaNews();
  if (!movie) return null;

  const sinhalaOverview = await generateSinhalaSynopsis(movie.title, movie.overview, movie.genres);
  const releaseYear = (movie.releaseDate || "").split("-")[0] || "2026";

  const caption = 
`🎬 *FILMFEED DAILY CINEMA NEWS — අද දින විශේෂ සිනමා පුවත්* 🍿
━━━━━━━━━━━━━━━━━━━━
🔥 *${movie.title} (${releaseYear})*
⭐ *IMDb / TMDb Rating:* ${movie.rating} / 10
🎭 *ප්‍රභේදය (Genre):* ${movie.genres}
📅 *නිකුත් වූ දිනය:* ${movie.releaseDate}

📝 *කතාව සැකෙවින් (Synopsis in Sinhala):*
${sinhalaOverview}

⚡ *නවතම තොරතුරු & Viewing Options:*
• *4K Ultra HD Streaming:* FilmFeed Player එකෙන් Buffer නොවී දැන්ම නරඹන්න!
  🔗 https://nexus-one-orpin.vercel.app/movie/${movie.id}

• *Direct Download Links:* FilmFeed Bot හරහා පහසුවෙන්ම ලබාගත හැක:
  👉 Type: *.movie ${movie.title}*

━━━━━━━━━━━━━━━━━━━━
📢 *දිනපතා අලුත්ම සිනමා පුවත් & Direct Movie Drops සඳහා අපගේ VIP Channel එක Follow කරන්න:*
👉 ${OFFICIAL_CHANNEL_URL}

> 🌍 *FILMFEED CINEMA NETWORK*
> *“Cinema Experience At Your Fingertips”* 🚀`;

  return {
    movieId: movie.id,
    posterUrl: movie.posterUrl,
    caption,
  };
}

/**
 * Broadcasts to Channel and/or Target Groups
 */
async function broadcastDailyNews(sock, channelJid = null, targetGroupJids = []) {
  try {
    const post = await buildChannelNewsPost();
    if (!post || !post.posterUrl) return false;

    // 1. Post to WhatsApp Channel (if bot is Admin of the Channel)
    if (channelJid) {
      try {
        await sock.sendMessage(channelJid, {
          image: { url: post.posterUrl },
          caption: post.caption,
        });
        console.log(`✅ [DailyNews] Successfully published daily news to Channel: ${channelJid}`);
      } catch (chErr) {
        console.warn(`[DailyNews] Could not post to channel (ensure bot is Admin):`, chErr.message);
      }
    }

    // 2. Broadcast to user's Groups
    for (const groupJid of targetGroupJids) {
      try {
        await sock.sendMessage(groupJid, {
          image: { url: post.posterUrl },
          caption: post.caption,
        });
        console.log(`✅ [DailyNews] Broadcasted daily news to group: ${groupJid}`);
      } catch (gErr) {
        console.warn(`[DailyNews] Could not post to group ${groupJid}:`, gErr.message);
      }
    }

    savePostedMovie(post.movieId);
    return true;
  } catch (err) {
    console.error("[DailyNews] Broadcast error:", err.message);
    return false;
  }
}

module.exports = {
  fetchTrendingCinemaNews,
  buildChannelNewsPost,
  broadcastDailyNews,
};
