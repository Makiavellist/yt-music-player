import { MODULE_ID, SOCKET_NAME, PS, REPEAT_MODES } from "./constants.js";
import { loadYouTubeAPI, parseYouTubeInput, fetchPlaylistIds, fetchVideoInfo } from "./youtube.js";

const HEARTBEAT_MS = 5000;
const DRIFT_TOLERANCE = 3;

const L = (key, data) => (data ? game.i18n.format(`YTMP.${key}`, data) : game.i18n.localize(`YTMP.${key}`));

/**
 * Owns the single hidden YouTube player, the queue, and GM -> player synchronisation.
 *
 * Roles:
 *  - Leader:   a GM while "Broadcast to players" is on. Controls the music; state goes out over the socket.
 *  - Follower: a player while broadcasting is on and "Listen to the GM's music" is on. Mirrors the leader.
 *  - Local:    anyone else. A private player that only they hear.
 */
export class MusicController {
  constructor() {
    this.queue = [];          // [{id, title, author, error}]
    this.index = -1;
    this.repeat = "off";      // "off" | "all" | "one"
    this.player = null;
    this._playerPromise = null;
    this.remote = null;       // last state received from the GM
    this.busy = null;         // status text while loading a playlist
    this.needsGesture = false;
    this._stopped = true;
    this._errorStreak = 0;
    this._apps = new Set();

    this._save = foundry.utils.debounce(this._saveNow.bind(this), 800);
    this._changed = foundry.utils.debounce(this._changedNow.bind(this), 200);
    this._saveVolume = foundry.utils.debounce(v => game.settings.set(MODULE_ID, "volume", v), 400);
    this._renderQueued = new Set();
    this._renderNow = foundry.utils.debounce(this._flushRender.bind(this), 60);
  }

  /* -------------------------------------------- */
  /*  Role helpers                                */
  /* -------------------------------------------- */

  get broadcastEnabled() { return game.settings.get(MODULE_ID, "broadcast"); }
  get isLeader() { return game.user.isGM && this.broadcastEnabled; }
  get isFollower() { return !game.user.isGM && this.broadcastEnabled && game.settings.get(MODULE_ID, "listen"); }
  get canControl() { return !this.isFollower; }
  get current() { return this.queue[this.index] ?? null; }
  get volume() { return Number(game.settings.get(MODULE_ID, "volume")) || 0; }

  /** Queue and index as the current user should see them. */
  get viewQueue() { return this.isFollower ? (this.remote?.queue ?? []) : this.queue; }
  get viewIndex() { return this.isFollower ? (this.remote?.index ?? -1) : this.index; }

  get playerState() {
    try { return this.player?.getPlayerState?.() ?? PS.UNSTARTED; }
    catch { return PS.UNSTARTED; }
  }

  get isPlaying() {
    const s = this.playerState;
    return s === PS.PLAYING || s === PS.BUFFERING;
  }

  get loadedId() {
    try { return this.player?.getVideoData?.()?.video_id || null; }
    catch { return null; }
  }

  get currentTime() {
    try { return Number(this.player?.getCurrentTime?.()) || 0; } catch { return 0; }
  }

  get duration() {
    try { return Number(this.player?.getDuration?.()) || 0; } catch { return 0; }
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  init() {
    game.socket.on(SOCKET_NAME, msg => this._onSocket(msg));
    this._restore();
    setInterval(() => {
      if (this.isLeader && !this._stopped && this.isPlaying) this._broadcast(false);
    }, HEARTBEAT_MS);
    if (this.isFollower) this.requestSync();
  }

  registerApp(app) { this._apps.add(app); }
  unregisterApp(app) { this._apps.delete(app); }

  /** Re-render the given parts of every open player window. */
  renderApps(parts = ["status", "queue"]) {
    for (const p of parts) this._renderQueued.add(p);
    this._renderNow();
  }

  _flushRender() {
    const parts = [...this._renderQueued];
    this._renderQueued.clear();
    for (const app of this._apps) if (app.rendered) app.render({ parts });
  }

  /** Called when the broadcast or listen settings change. */
  async onModeChange() {
    this.needsGesture = false;
    if (this.isFollower) {
      if (this.player) this.player.stopVideo();
      this.requestSync();
    } else if (!game.user.isGM) {
      // A player who stopped following: silence the GM's track and go back to their own queue.
      if (this.player) this.player.stopVideo();
      this.remote = null;
      this._restore();
    } else if (this.isLeader) {
      this._broadcast(true);
    } else {
      // GM turned broadcasting off: tell everyone to stop.
      game.socket.emit(SOCKET_NAME, { type: "state", state: { v: null, playing: false, queue: [], index: -1 } });
    }
    this.renderApps(["status", "add", "queue", "footer"]);
  }

  /** Create the persistent YouTube player on first use. */
  ensurePlayer() {
    if (this._playerPromise) return this._playerPromise;
    this._playerPromise = (async () => {
      const YT = await loadYouTubeAPI();
      let host = document.getElementById("ytmp-player-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "ytmp-player-host";
        const target = document.createElement("div");
        target.id = "ytmp-player";
        host.append(target);
        document.body.append(host);
      }
      this.applyVideoVisibility();

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The YouTube player did not start.")), 20000);
        const options = {
          width: 320,
          height: 180,
          playerVars: {
            autoplay: 0,
            controls: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            enablejsapi: 1,
            origin: window.location.origin
          },
          events: {
            onReady: event => {
              clearTimeout(timer);
              this.player = event.target;
              try { this.player.setVolume(this.volume); } catch { /* ignore */ }
              resolve(this.player);
            },
            onStateChange: event => this._onStateChange(event),
            onError: event => this._onError(event)
          }
        };
        if (game.settings.get(MODULE_ID, "noCookie")) options.host = "https://www.youtube-nocookie.com";
        new YT.Player("ytmp-player", options);
      });
    })().catch(err => {
      this._playerPromise = null;
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(`${L("Title")}: ${err.message}`);
      throw err;
    });
    return this._playerPromise;
  }

  applyVideoVisibility() {
    const host = document.getElementById("ytmp-player-host");
    host?.classList.toggle("ytmp-visible", !!game.settings.get(MODULE_ID, "showVideo"));
  }

  /* -------------------------------------------- */
  /*  Persistence                                 */
  /* -------------------------------------------- */

  _restore() {
    const saved = game.settings.get(MODULE_ID, "state") ?? {};
    this.queue = Array.isArray(saved.queue)
      ? saved.queue.filter(t => t?.id).map(t => ({ id: t.id, title: t.title ?? null, author: t.author ?? null }))
      : [];
    this.index = Number.isInteger(saved.index) && saved.index < this.queue.length ? saved.index : (this.queue.length ? 0 : -1);
    this.repeat = REPEAT_MODES.includes(saved.repeat) ? saved.repeat : "off";
    this._stopped = true;
    this._fillTitles(this.queue);
  }

  _saveNow() {
    if (this.isFollower) return;
    const state = {
      queue: this.queue.map(({ id, title, author }) => ({ id, title, author })),
      index: this.index,
      repeat: this.repeat
    };
    game.settings.set(MODULE_ID, "state", state).catch(err => console.error(`${MODULE_ID} |`, err));
  }

  _changedNow() {
    this._save();
    this._broadcast(true);
    this.renderApps(["status", "queue", "footer"]);
  }

  /* -------------------------------------------- */
  /*  Transport                                   */
  /* -------------------------------------------- */

  async playIndex(i) {
    if (!this.canControl || i < 0 || i >= this.queue.length) return;
    this.index = i;
    this._stopped = false;
    const player = await this.ensurePlayer();
    player.loadVideoById(this.queue[i].id);
    this._changed();
  }

  async togglePlay() {
    if (!this.canControl) return;
    if (!this.queue.length) return ui.notifications.info(L("QueueEmpty"));
    if (this.index < 0) return this.playIndex(0);
    const player = await this.ensurePlayer();
    if (this.loadedId !== this.current.id) return this.playIndex(this.index);
    if (this.isPlaying) {
      player.pauseVideo();
    } else {
      this._stopped = false;
      if (this.playerState === PS.ENDED) player.seekTo(0, true);
      player.playVideo();
    }
  }

  async stop() {
    if (!this.canControl || !this.player) return;
    this.player.stopVideo();
    this._stopped = true;
    this._broadcast(false);
    this.renderApps(["status"]);
  }

  async next({ auto = false } = {}) {
    if (!this.canControl || !this.queue.length) return;
    let i = this.index + 1;
    if (i >= this.queue.length) {
      if (this.repeat === "all") i = 0;
      else {
        if (!auto) ui.notifications.info(L("EndOfQueue"));
        this._stopped = true;
        this._broadcast(false);
        this.renderApps(["status"]);
        return;
      }
    }
    return this.playIndex(i);
  }

  async previous() {
    if (!this.canControl || !this.queue.length) return;
    if (this.player && this.currentTime > 3 && this.loadedId === this.current?.id) {
      this.player.seekTo(0, true);
      this._broadcastSoon();
      return;
    }
    let i = this.index - 1;
    if (i < 0) i = this.repeat === "all" ? this.queue.length - 1 : 0;
    return this.playIndex(i);
  }

  seek(seconds) {
    if (!this.canControl || !this.player) return;
    this.player.seekTo(Math.max(0, Number(seconds) || 0), true);
    this._broadcastSoon();
  }

  setRepeat(mode) {
    if (!this.canControl) return;
    this.repeat = REPEAT_MODES.includes(mode) ? mode : REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    this._changed();
  }

  cycleRepeat() { this.setRepeat(null); }

  setVolume(value) {
    const v = Math.clamp(Math.round(Number(value) || 0), 0, 100);
    if (this.player) {
      try {
        this.player.setVolume(v);
        if (v > 0 && this.player.isMuted()) this.player.unMute();
      } catch { /* ignore */ }
    }
    this._saveVolume(v);
  }

  /* -------------------------------------------- */
  /*  Queue management                            */
  /* -------------------------------------------- */

  /**
   * Add a video or playlist link.
   * @param {string} input
   * @param {object} [options]
   * @param {boolean} [options.replace]  Replace the queue and start playing immediately.
   */
  async addFromInput(input, { replace = false } = {}) {
    if (!this.canControl) return false;
    const parsed = parseYouTubeInput(input);
    if (!parsed) {
      ui.notifications.warn(L("InvalidLink"));
      return false;
    }

    let ids = [];
    let startAt = 0;
    if (parsed.listId) {
      this.busy = L("LoadingPlaylist");
      this.renderApps(["status"]);
      try {
        ids = await fetchPlaylistIds(parsed.listId, { noCookie: game.settings.get(MODULE_ID, "noCookie") });
      } catch (err) {
        console.warn(`${MODULE_ID} |`, err);
        if (!parsed.videoId) ui.notifications.error(err.message);
        else ui.notifications.warn(L("PlaylistFallback"));
      } finally {
        this.busy = null;
        this.renderApps(["status"]);
      }
      if (!ids.length && parsed.videoId) ids = [parsed.videoId];
      else if (parsed.videoId) startAt = Math.max(0, ids.indexOf(parsed.videoId));
    } else {
      ids = [parsed.videoId];
    }
    if (!ids.length) return false;

    const tracks = ids.map(id => ({ id, title: null, author: null }));
    const wasEmpty = !this.queue.length;
    let playFrom;
    if (replace) {
      this.queue = tracks;
      this.index = -1;
      playFrom = startAt;
    } else {
      playFrom = this.queue.length + startAt;
      this.queue.push(...tracks);
    }
    this._fillTitles(tracks);

    if (tracks.length > 1) ui.notifications.info(L("AddedTracks", { count: tracks.length }));
    if (replace || wasEmpty || this.index < 0) await this.playIndex(playFrom);
    else this._changed();
    return true;
  }

  async removeTrack(i) {
    if (!this.canControl || i < 0 || i >= this.queue.length) return;
    const removingCurrent = i === this.index;
    const wasPlaying = removingCurrent && this.isPlaying;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    else if (removingCurrent) {
      if (!this.queue.length) this.index = -1;
      else this.index = Math.min(i, this.queue.length - 1);
      if (this.player) this.player.stopVideo();
      this._stopped = true;
      if (wasPlaying && this.index >= 0) return this.playIndex(this.index);
    }
    this._changed();
  }

  moveTrack(from, to) {
    if (!this.canControl || from === to) return;
    if (from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) return;
    const current = this.current;
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, track);
    this.index = current ? this.queue.indexOf(current) : -1;
    this._changed();
  }

  shuffleQueue() {
    if (!this.canControl || this.queue.length < 2) return;
    const current = this.current;
    const rest = this.queue.filter(t => t !== current);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.queue = current ? [current, ...rest] : rest;
    this.index = current ? 0 : -1;
    this._changed();
  }

  clearQueue() {
    if (!this.canControl) return;
    if (this.player) this.player.stopVideo();
    this._stopped = true;
    this.queue = [];
    this.index = -1;
    this._changed();
  }

  /* -------------------------------------------- */
  /*  Saved playlists                             */
  /* -------------------------------------------- */

  get library() { return foundry.utils.deepClone(game.settings.get(MODULE_ID, "library") ?? {}); }

  async saveToLibrary(name) {
    name = String(name ?? "").trim();
    if (!name || !this.queue.length) return;
    const lib = this.library;
    lib[name] = this.queue.map(({ id, title, author }) => ({ id, title, author }));
    await game.settings.set(MODULE_ID, "library", lib);
    ui.notifications.info(L("SavedList", { name }));
    this.renderApps(["footer"]);
  }

  async loadFromLibrary(name, { replace = true } = {}) {
    if (!this.canControl) return;
    const tracks = this.library[name];
    if (!Array.isArray(tracks) || !tracks.length) return;
    const copy = tracks.map(t => ({ id: t.id, title: t.title ?? null, author: t.author ?? null }));
    if (replace) {
      this.queue = copy;
      this.index = -1;
      await this.playIndex(0);
    } else {
      const wasEmpty = !this.queue.length;
      this.queue.push(...copy);
      if (wasEmpty) await this.playIndex(0);
      else this._changed();
    }
    this._fillTitles(copy);
  }

  async deleteFromLibrary(name) {
    const lib = this.library;
    if (!(name in lib)) return;
    delete lib[name];
    await game.settings.set(MODULE_ID, "library", lib);
    this.renderApps(["footer"]);
  }

  /** Fetch titles in the background, four at a time. */
  async _fillTitles(tracks) {
    const pending = tracks.filter(t => !t.title);
    const worker = async () => {
      while (pending.length) {
        const track = pending.shift();
        const info = await fetchVideoInfo(track.id);
        if (info?.title) {
          track.title = info.title;
          track.author = info.author;
          this._changed();
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  /* -------------------------------------------- */
  /*  Player events                               */
  /* -------------------------------------------- */

  _onStateChange(event) {
    const state = event.data;

    if (state === PS.PLAYING) {
      this._errorStreak = 0;
      this.needsGesture = false;
      // Fill in a missing title from the player itself (covers oEmbed being blocked).
      const cur = this.current;
      try {
        const data = this.player.getVideoData();
        if (cur && data?.video_id === cur.id && !cur.title && data.title) {
          cur.title = data.title;
          cur.author = data.author || cur.author;
          this._changed();
        }
      } catch { /* ignore */ }
      if (cur?.error) { delete cur.error; this._changed(); }
    }

    if (!this.isFollower) {
      if (state === PS.ENDED) {
        if (this.repeat === "one") {
          this.player.seekTo(0, true);
          this.player.playVideo();
        } else {
          this.next({ auto: true });
        }
      }
      if (state === PS.PLAYING || state === PS.PAUSED || state === PS.ENDED) this._broadcast(false);
    }
    this.renderApps(["status"]);
  }

  _onError(event) {
    const code = event.data;
    const key = { 2: "Invalid", 5: "Html5", 100: "NotFound", 101: "NoEmbed", 150: "NoEmbed" }[code] ?? "Unknown";
    const title = (this.isFollower ? this.remote?.title : this.current?.title) || this.loadedId || "?";
    ui.notifications.warn(L(`Error.${key}`, { title }));
    if (this.isFollower) return;

    if (this.current) this.current.error = true;
    this._errorStreak++;
    this._changed();
    if (this.queue.length > 1 && this._errorStreak < this.queue.length) {
      setTimeout(() => this.next({ auto: true }), 800);
    } else {
      this._stopped = true;
      this._broadcast(false);
    }
  }

  /* -------------------------------------------- */
  /*  Sync                                        */
  /* -------------------------------------------- */

  _snapshot(full) {
    const cur = this.current;
    const active = !this._stopped && cur && this.loadedId === cur.id;
    const state = {
      v: active ? cur.id : null,
      title: cur?.title ?? null,
      author: cur?.author ?? null,
      playing: active ? this.isPlaying : false,
      t: active ? this.currentTime : 0,
      repeat: this.repeat,
      index: this.index
    };
    if (full) state.queue = this.queue.map(({ id, title, error }) => ({ id, title, error: !!error }));
    return state;
  }

  _broadcast(full = true) {
    if (!this.isLeader) return;
    game.socket.emit(SOCKET_NAME, { type: "state", state: this._snapshot(full) });
  }

  _broadcastSoon() {
    clearTimeout(this._broadcastTimer);
    this._broadcastTimer = setTimeout(() => this._broadcast(false), 300);
  }

  requestSync() {
    game.socket.emit(SOCKET_NAME, { type: "request", userId: game.user.id });
  }

  _onSocket(msg) {
    if (!msg?.type) return;
    if (msg.type === "request") {
      if (this.isLeader && this.queue.length) this._broadcast(true);
      return;
    }
    if (msg.type === "state" && !game.user.isGM) {
      this.remote = { ...(this.remote ?? {}), ...msg.state };
      if (this.isFollower) this._applyRemote();
      this.renderApps(msg.state.queue ? ["status", "queue"] : ["status"]);
    }
  }

  async _applyRemote() {
    const s = this.remote;
    if (!this.isFollower || !s) return;

    if (!s.v) {
      if (this.player && this.isPlaying) this.player.stopVideo();
      return;
    }

    let player;
    try { player = await this.ensurePlayer(); } catch { return; }
    if (!this.isFollower) return;

    const target = (Number(s.t) || 0) + (s.playing ? 0.4 : 0);
    if (this.loadedId !== s.v) {
      if (s.playing) player.loadVideoById({ videoId: s.v, startSeconds: target });
      else player.cueVideoById({ videoId: s.v, startSeconds: target });
    } else {
      const state = this.playerState;
      if (Math.abs(this.currentTime - target) > DRIFT_TOLERANCE) player.seekTo(target, true);
      if (s.playing && state !== PS.PLAYING && state !== PS.BUFFERING) player.playVideo();
      if (!s.playing && (state === PS.PLAYING || state === PS.BUFFERING)) player.pauseVideo();
    }
    if (s.playing) this._checkAutoplay();
  }

  /**
   * Browsers (Firefox included) block audible playback until the user has interacted with the page.
   * If playback did not start, ask the player to click once and retry on that click.
   */
  _checkAutoplay() {
    clearTimeout(this._autoplayTimer);
    this._autoplayTimer = setTimeout(() => {
      if (!this.isFollower || !this.remote?.playing) return;
      const state = this.playerState;
      if (state === PS.PLAYING || state === PS.BUFFERING) return;
      if (this.needsGesture) return;
      this.needsGesture = true;
      ui.notifications.info(L("ClickToEnable"));
      this.renderApps(["status"]);
      const resume = () => {
        this.needsGesture = false;
        try { this.player?.playVideo(); } catch { /* ignore */ }
        this._applyRemote();
        this.renderApps(["status"]);
      };
      document.addEventListener("pointerdown", resume, { once: true, capture: true });
    }, 2500);
  }
}
