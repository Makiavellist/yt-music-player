import { MODULE_ID, TEMPLATE_PATH, formatTime, thumbnailUrl } from "./constants.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const L = key => game.i18n.localize(`YTMP.${key}`);

export class MusicPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(controller, options = {}) {
    super(options);
    this.controller = controller;
    this._draft = "";
    this._seeking = false;
    this._tick = null;
  }

  static DEFAULT_OPTIONS = {
    id: "ytmp-app",
    classes: ["ytmp-app"],
    tag: "div",
    window: {
      title: "YTMP.Title",
      icon: "fa-brands fa-youtube",
      resizable: true
    },
    position: { width: 420, height: 640 },
    actions: {
      togglePlay: MusicPlayerApp.#onTogglePlay,
      stop: MusicPlayerApp.#onStop,
      next: MusicPlayerApp.#onNext,
      previous: MusicPlayerApp.#onPrevious,
      repeat: MusicPlayerApp.#onRepeat,
      shuffle: MusicPlayerApp.#onShuffle,
      clear: MusicPlayerApp.#onClear,
      addPlay: MusicPlayerApp.#onAddPlay,
      addQueue: MusicPlayerApp.#onAddQueue,
      playTrack: MusicPlayerApp.#onPlayTrack,
      removeTrack: MusicPlayerApp.#onRemoveTrack,
      saveList: MusicPlayerApp.#onSaveList,
      loadList: MusicPlayerApp.#onLoadList,
      appendList: MusicPlayerApp.#onAppendList,
      deleteList: MusicPlayerApp.#onDeleteList,
      toggleVideo: MusicPlayerApp.#onToggleVideo,
      toggleListen: MusicPlayerApp.#onToggleListen
    }
  };

  static PARTS = {
    status: { template: `${TEMPLATE_PATH}/status.hbs` },
    add: { template: `${TEMPLATE_PATH}/add.hbs` },
    queue: { template: `${TEMPLATE_PATH}/queue.hbs`, scrollable: [".ytmp-queue"] },
    footer: { template: `${TEMPLATE_PATH}/footer.hbs` }
  };

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const c = this.controller;
    const queue = c.viewQueue;
    const index = c.viewIndex;
    const nowTrack = c.isFollower
      ? (c.remote?.v ? { id: c.remote.v, title: c.remote.title, author: c.remote.author } : null)
      : c.current;
    const repeat = c.isFollower ? (c.remote?.repeat ?? "off") : c.repeat;
    const playing = c.isPlaying;

    const repeatInfo = {
      off: { icon: "fa-solid fa-repeat", label: L("RepeatOff"), cls: "" },
      all: { icon: "fa-solid fa-repeat", label: L("RepeatAll"), cls: "active" },
      one: { icon: "fa-solid fa-repeat", label: L("RepeatOne"), cls: "active one" }
    }[repeat];

    const library = c.canControl ? Object.keys(c.library).sort((a, b) => a.localeCompare(b)) : [];

    return {
      isGM: game.user.isGM,
      isLeader: c.isLeader,
      isFollower: c.isFollower,
      canControl: c.canControl,
      broadcastEnabled: c.broadcastEnabled,
      listening: game.settings.get(MODULE_ID, "listen"),
      showVideo: game.settings.get(MODULE_ID, "showVideo"),
      busy: c.busy,
      needsGesture: c.needsGesture,
      playing,
      playIcon: playing ? "fa-solid fa-pause" : "fa-solid fa-play",
      playLabel: playing ? L("Pause") : L("Play"),
      repeat: repeatInfo,
      repeatOne: repeat === "one",
      now: nowTrack
        ? {
          title: nowTrack.title || nowTrack.id,
          author: nowTrack.author || "",
          thumb: thumbnailUrl(nowTrack.id),
          url: `https://www.youtube.com/watch?v=${nowTrack.id}`
        }
        : null,
      volume: c.volume,
      draft: this._draft,
      queueCount: queue.length,
      queue: queue.map((t, i) => ({
        index: i,
        num: i + 1,
        id: t.id,
        title: t.title || t.id,
        thumb: thumbnailUrl(t.id),
        active: i === index,
        error: !!t.error
      })),
      library,
      hasLibrary: library.length > 0
    };
  }

  /* -------------------------------------------- */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.controller.registerApp(this);
    this.controller.ensurePlayer().catch(() => {});
    this._tick = setInterval(() => this._updateProgress(), 500);
  }

  _onClose(options) {
    super._onClose?.(options);
    this.controller.unregisterApp(this);
    clearInterval(this._tick);
    this._tick = null;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    // URL box: Enter adds to the queue, the draft survives re-renders.
    const input = root.querySelector("input.ytmp-url");
    if (input && !input.dataset.bound) {
      input.dataset.bound = "1";
      input.addEventListener("input", () => { this._draft = input.value; });
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        this._submit(event.shiftKey);
      });
    }

    // Seek bar: preview while dragging, seek on release.
    const seek = root.querySelector("input.ytmp-seek");
    if (seek && !seek.dataset.bound) {
      seek.dataset.bound = "1";
      seek.addEventListener("input", () => {
        this._seeking = true;
        const cur = root.querySelector(".ytmp-time-current");
        if (cur) cur.textContent = formatTime(seek.value);
      });
      seek.addEventListener("change", () => {
        this.controller.seek(Number(seek.value));
        this._seeking = false;
      });
    }

    // Local volume.
    const vol = root.querySelector("input.ytmp-volume-range");
    if (vol && !vol.dataset.bound) {
      vol.dataset.bound = "1";
      const label = root.querySelector(".ytmp-volume-value");
      vol.addEventListener("input", () => {
        this.controller.setVolume(vol.value);
        if (label) label.textContent = vol.value;
        this._paintRange(vol);
      });
      this._paintRange(vol);
    }

    this._bindDragDrop(root);
    this._updateProgress();
  }

  /* -------------------------------------------- */

  /** Firefox paints range progress natively; this keeps WebKit/Chromium consistent via a CSS variable. */
  _paintRange(range) {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const pct = max > min ? ((Number(range.value) - min) / (max - min)) * 100 : 0;
    range.style.setProperty("--ytmp-fill", `${pct}%`);
  }

  _updateProgress() {
    if (!this.rendered) return;
    const root = this.element;
    const seek = root.querySelector("input.ytmp-seek");
    const cur = root.querySelector(".ytmp-time-current");
    const dur = root.querySelector(".ytmp-time-duration");
    if (!seek) return;
    const c = this.controller;
    const duration = c.duration;
    const time = c.currentTime;
    seek.max = String(Math.max(0, Math.floor(duration)));
    if (!this._seeking) {
      seek.value = String(Math.floor(time));
      if (cur) cur.textContent = formatTime(time);
    }
    if (dur) dur.textContent = formatTime(duration);
    this._paintRange(seek);

    // Keep the play/pause icon honest even if a state event was missed.
    const btn = root.querySelector('[data-action="togglePlay"] i');
    if (btn) {
      const want = c.isPlaying ? "fa-pause" : "fa-play";
      if (!btn.classList.contains(want)) {
        btn.classList.remove("fa-pause", "fa-play");
        btn.classList.add(want);
      }
    }
  }

  _bindDragDrop(root) {
    if (!this.controller.canControl) return;
    const list = root.querySelector(".ytmp-queue");
    if (!list || list.dataset.bound) return;
    list.dataset.bound = "1";

    list.addEventListener("dragstart", event => {
      const li = event.target.closest?.("li[data-index]");
      if (!li) return;
      // Firefox will not start a drag unless data is set.
      event.dataTransfer.setData("text/plain", li.dataset.index);
      event.dataTransfer.effectAllowed = "move";
      li.classList.add("dragging");
    });
    list.addEventListener("dragend", event => {
      event.target.closest?.("li")?.classList.remove("dragging");
      list.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
    });
    list.addEventListener("dragover", event => {
      const li = event.target.closest?.("li[data-index]");
      if (!li) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      list.querySelectorAll(".drop-target").forEach(el => el !== li && el.classList.remove("drop-target"));
      li.classList.add("drop-target");
    });
    list.addEventListener("drop", event => {
      const li = event.target.closest?.("li[data-index]");
      if (!li) return;
      event.preventDefault();
      event.stopPropagation();
      const from = Number(event.dataTransfer.getData("text/plain"));
      const to = Number(li.dataset.index);
      li.classList.remove("drop-target");
      if (Number.isInteger(from) && Number.isInteger(to)) this.controller.moveTrack(from, to);
    });
  }

  async _submit(replace) {
    const value = (this.element.querySelector("input.ytmp-url")?.value ?? this._draft).trim();
    if (!value) return;
    const ok = await this.controller.addFromInput(value, { replace });
    if (ok) {
      this._draft = "";
      const input = this.element?.querySelector("input.ytmp-url");
      if (input) input.value = "";
    }
  }

  _selectedList() {
    return this.element.querySelector("select.ytmp-library")?.value || null;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onTogglePlay() { this.controller.togglePlay(); }
  static #onStop() { this.controller.stop(); }
  static #onNext() { this.controller.next(); }
  static #onPrevious() { this.controller.previous(); }
  static #onRepeat() { this.controller.cycleRepeat(); }
  static #onShuffle() { this.controller.shuffleQueue(); }
  static #onAddPlay() { this._submit(true); }
  static #onAddQueue() { this._submit(false); }

  static async #onClear() {
    if (!this.controller.queue.length) return;
    const ok = await DialogV2.confirm({
      window: { title: L("ClearQueue") },
      content: `<p>${L("ClearQueueConfirm")}</p>`
    });
    if (ok) this.controller.clearQueue();
  }

  static #onPlayTrack(event, target) {
    const i = Number(target.closest("[data-index]")?.dataset.index);
    if (Number.isInteger(i)) this.controller.playIndex(i);
  }

  static #onRemoveTrack(event, target) {
    event.stopPropagation();
    const i = Number(target.closest("[data-index]")?.dataset.index);
    if (Number.isInteger(i)) this.controller.removeTrack(i);
  }

  static async #onSaveList() {
    if (!this.controller.queue.length) return ui.notifications.info(L("QueueEmpty"));
    const name = await DialogV2.prompt({
      window: { title: L("SaveQueue") },
      content: `<div class="form-group"><label>${L("PlaylistName")}</label><input type="text" name="name" autofocus required></div>`,
      ok: {
        label: L("Save"),
        callback: (event, button) => button.form.elements.name.value
      },
      rejectClose: false
    });
    if (name) this.controller.saveToLibrary(name);
  }

  static #onLoadList() {
    const name = this._selectedList();
    if (name) this.controller.loadFromLibrary(name, { replace: true });
  }

  static #onAppendList() {
    const name = this._selectedList();
    if (name) this.controller.loadFromLibrary(name, { replace: false });
  }

  static async #onDeleteList() {
    const name = this._selectedList();
    if (!name) return;
    const ok = await DialogV2.confirm({
      window: { title: L("DeleteList") },
      content: `<p>${game.i18n.format("YTMP.DeleteListConfirm", { name: foundry.utils.escapeHTML?.(name) ?? name })}</p>`
    });
    if (ok) this.controller.deleteFromLibrary(name);
  }

  static async #onToggleVideo() {
    await game.settings.set(MODULE_ID, "showVideo", !game.settings.get(MODULE_ID, "showVideo"));
  }

  static async #onToggleListen() {
    await game.settings.set(MODULE_ID, "listen", !game.settings.get(MODULE_ID, "listen"));
  }
}
