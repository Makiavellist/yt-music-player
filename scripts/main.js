import { MODULE_ID } from "./constants.js";
import { MusicController } from "./controller.js";
import { MusicPlayerApp } from "./app.js";

let controller = null;
let app = null;

function getApp() {
  app ??= new MusicPlayerApp(controller);
  return app;
}

/** Public API: game.modules.get("yt-music-player").api — handy for macros. */
const api = {
  open() {
    const a = getApp();
    if (a.rendered) a.bringToFront();
    else a.render({ force: true });
    return a;
  },
  close() { return app?.close(); },
  toggle() { return app?.rendered ? app.close() : api.open(); },
  /** Replace the queue with a video or playlist link and start playing. */
  play: url => controller.addFromInput(url, { replace: true }),
  /** Append a video or playlist link to the queue. */
  add: url => controller.addFromInput(url, { replace: false }),
  /** Play one of your saved playlists by name. */
  playSaved: name => controller.loadFromLibrary(name, { replace: true }),
  togglePlay: () => controller.togglePlay(),
  stop: () => controller.stop(),
  next: () => controller.next(),
  previous: () => controller.previous(),
  /** "off" | "all" | "one" */
  setRepeat: mode => controller.setRepeat(mode),
  setVolume: v => controller.setVolume(v),
  get controller() { return controller; }
};

Hooks.once("init", () => {
  const S = key => `YTMP.Settings.${key}`;

  game.settings.register(MODULE_ID, "broadcast", {
    name: `${S("Broadcast")}.Name`,
    hint: `${S("Broadcast")}.Hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => controller?.onModeChange()
  });

  game.settings.register(MODULE_ID, "listen", {
    name: `${S("Listen")}.Name`,
    hint: `${S("Listen")}.Hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => controller?.onModeChange()
  });

  game.settings.register(MODULE_ID, "showVideo", {
    name: `${S("ShowVideo")}.Name`,
    hint: `${S("ShowVideo")}.Hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      controller?.applyVideoVisibility();
      controller?.renderApps(["footer"]);
    }
  });

  game.settings.register(MODULE_ID, "noCookie", {
    name: `${S("NoCookie")}.Name`,
    hint: `${S("NoCookie")}.Hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, "volume", {
    scope: "client",
    config: false,
    type: Number,
    default: 50
  });

  // Stored per user on the server, so the queue follows you between browsers.
  game.settings.register(MODULE_ID, "state", {
    scope: "user",
    config: false,
    type: Object,
    default: { queue: [], index: -1, repeat: "off" }
  });

  game.settings.register(MODULE_ID, "library", {
    scope: "user",
    config: false,
    type: Object,
    default: {}
  });

  game.keybindings.register(MODULE_ID, "toggle", {
    name: "YTMP.Keybindings.Toggle",
    editable: [],
    onDown: () => { api.toggle(); return true; }
  });
  game.keybindings.register(MODULE_ID, "playPause", {
    name: "YTMP.Keybindings.PlayPause",
    editable: [],
    onDown: () => { controller?.togglePlay(); return true; }
  });
  game.keybindings.register(MODULE_ID, "next", {
    name: "YTMP.Keybindings.Next",
    editable: [],
    onDown: () => { controller?.next(); return true; }
  });
});

Hooks.once("ready", () => {
  controller = new MusicController();
  controller.init();
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
});

// Button on the Ambient Sound scene controls (GM).
Hooks.on("getSceneControlButtons", controls => {
  const sounds = controls?.sounds;
  if (!sounds?.tools) return;
  sounds.tools.ytMusicPlayer = {
    name: "ytMusicPlayer",
    title: "YTMP.Open",
    icon: "fa-brands fa-youtube",
    button: true,
    order: Object.keys(sounds.tools).length + 1,
    onChange: () => api.open()
  };
});

// Button in the Playlists sidebar tab (everyone).
Hooks.on("renderPlaylistDirectory", (directory, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".ytmp-open-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ytmp-open-button";
  button.innerHTML = `<i class="fa-brands fa-youtube"></i> ${game.i18n.localize("YTMP.OpenButton")}`;
  button.addEventListener("click", event => {
    event.preventDefault();
    api.open();
  });
  const target = root.querySelector(".directory-header .header-actions")
    ?? root.querySelector(".directory-header")
    ?? root;
  target.append(button);
});
