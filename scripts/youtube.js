/**
 * YouTube helpers: IFrame API loader, URL parsing, playlist expansion and title lookup.
 * Nothing here needs an API key.
 */

const API_SRC = "https://www.youtube.com/iframe_api";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID_RE = /^(PL|OL|UU|FL|LL|RD|OLAK5uy_)[A-Za-z0-9_-]{8,}$/;

let apiPromise = null;

/** Load the YouTube IFrame API once and resolve with the global YT object. */
export function loadYouTubeAPI() {
  if (window.YT?.Player && window.YT.loaded) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    // Chain any callback another module may already have installed.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try { if (typeof previous === "function") previous(); }
      catch (err) { console.error(err); }
      resolve(window.YT);
    };

    // Someone else may already be loading the script; only add it if absent.
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const tag = document.createElement("script");
      tag.src = API_SRC;
      tag.async = true;
      tag.onerror = () => {
        apiPromise = null;
        reject(new Error("Could not load the YouTube IFrame API. A content blocker or network filter may be blocking youtube.com."));
      };
      document.head.append(tag);
    }

    setTimeout(() => {
      if (!window.YT?.Player) {
        apiPromise = null;
        reject(new Error("Timed out loading the YouTube IFrame API."));
      }
    }, 20000);
  });
  return apiPromise;
}

/**
 * Parse anything a user might paste: a full watch URL, youtu.be short link, shorts/embed/live URL,
 * a music.youtube.com link, a playlist URL, or a bare video / playlist id.
 * @returns {{videoId: string|null, listId: string|null}|null}
 */
export function parseYouTubeInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return null;
  if (VIDEO_ID_RE.test(input)) return { videoId: input, listId: null };
  if (LIST_ID_RE.test(input)) return { videoId: null, listId: input };

  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let videoId = null;
  let listId = url.searchParams.get("list");

  if (host === "youtu.be") {
    videoId = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) videoId = m[1];
    }
  } else {
    return null;
  }

  if (videoId && !VIDEO_ID_RE.test(videoId)) videoId = null;
  if (listId && !/^[A-Za-z0-9_-]{2,}$/.test(listId)) listId = null;
  // "WL" (Watch Later) and "LL" (Liked) are private to the signed-in user and cannot be embedded.
  if (listId === "WL" || listId === "LL") listId = null;
  if (!videoId && !listId) return null;
  return { videoId, listId };
}

/**
 * Expand a playlist id into its video ids using a temporary, muted, off-screen player.
 * The IFrame API reports at most the first 200 entries of very long playlists.
 */
export async function fetchPlaylistIds(listId, { noCookie = false, timeout = 20000 } = {}) {
  const YT = await loadYouTubeAPI();
  const holder = document.createElement("div");
  holder.className = "ytmp-offscreen";
  const target = document.createElement("div");
  holder.append(target);
  document.body.append(holder);

  let player = null;
  let pollTimer = null;
  let killTimer = null;
  try {
    return await new Promise((resolve, reject) => {
      killTimer = setTimeout(() => reject(new Error("The playlist could not be read. It may be private, empty or unavailable in your region.")), timeout);

      const options = {
        width: 200,
        height: 200,
        playerVars: {
          autoplay: 0,
          controls: 0,
          listType: "playlist",
          list: listId,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            try { player.mute(); } catch { /* ignore */ }
            const started = Date.now();
            let recued = false;
            const check = () => {
              let ids = null;
              try { ids = player.getPlaylist(); } catch { /* not ready yet */ }
              if (Array.isArray(ids) && ids.length) {
                resolve(ids.filter(Boolean));
                return;
              }
              // Some browsers need an explicit cue before the list is populated.
              if (!recued && Date.now() - started > 3000) {
                recued = true;
                try { player.cuePlaylist({ listType: "playlist", list: listId }); } catch { /* ignore */ }
              }
              pollTimer = setTimeout(check, 250);
            };
            check();
          }
        }
      };
      if (noCookie) options.host = "https://www.youtube-nocookie.com";
      player = new YT.Player(target, options);
    });
  } finally {
    clearTimeout(pollTimer);
    clearTimeout(killTimer);
    try { player?.destroy(); } catch { /* ignore */ }
    holder.remove();
  }
}

const infoCache = new Map();

/** Look up a video's title and channel through YouTube's public oEmbed endpoint (CORS-enabled). */
export function fetchVideoInfo(videoId) {
  if (infoCache.has(videoId)) return infoCache.get(videoId);
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const request = fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer"
  })
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j ? { title: j.title ?? null, author: j.author_name ?? null } : null))
    .catch(() => null);
  infoCache.set(videoId, request);
  return request;
}
