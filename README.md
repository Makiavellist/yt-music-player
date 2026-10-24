# YouTube Music Player for Foundry VTT

A system-agnostic music player for Foundry VTT **v13** (verified on build 351). Paste a YouTube video or playlist link and listen without leaving Foundry.

## Features

- Play any YouTube video link (watch, youtu.be, shorts, embed, music.youtube.com) or a bare video id.
- Load a **whole YouTube playlist** into the queue and jump between songs by clicking them.
- **Repeat** modes: off, whole queue, or **this song** (single-song loop).
- Previous / play-pause / stop / next, seek bar, per-computer volume.
- Drag and drop to reorder the queue, shuffle, remove tracks, clear the queue.
- Save the current queue as a named playlist and reload it later (stored per user).
- **Broadcast mode** (on by default): the GM's music plays in sync for every player. Players control their own volume and can opt out.
- Works with any game system; no API key needed.

## Install

**Manifest URL (recommended):** in Foundry's setup screen go to *Add-on Modules → Install Module* and paste:

```
https://github.com/Makiavellist/yt-music-player/releases/latest/download/module.json
```

**Manual:** download `yt-music-player.zip` from the [latest release](https://github.com/Makiavellist/yt-music-player/releases/latest) and unzip it into `Data/modules/yt-music-player/`, so that `Data/modules/yt-music-player/module.json` exists.

Then open your world and enable **YouTube Music Player** under *Manage Modules*.

## Use

Open the player from either:
- the **YouTube Music** button at the top of the **Playlists** sidebar tab (everyone), or
- the YouTube icon in the **Ambient Sound** scene controls (GM).

Paste a link in the box:
- **Enter** / **Add to queue** appends it.
- **Shift+Enter** / **Play now** replaces the queue and starts playing.

A playlist link (`...playlist?list=...` or a watch link with `&list=...`) loads every song in the playlist. If the link points at a specific video inside the playlist, playback starts there.

Click the repeat button to cycle **off → whole queue → this song** (shows a small "1").

Optional keybindings (unassigned by default) are under *Configure Controls*: open/close player, play/pause, next track.

## Settings

| Setting | Scope | Description |
| --- | --- | --- |
| Broadcast GM music to players | World | GM's player is mirrored on every player's computer. |
| Listen to the GM's music | Per computer | Players can mute the broadcast and use a private player instead. |
| Show video | Per computer | Shows a small video window near the top-right of the screen. |
| Use youtube-nocookie.com | Per computer | Privacy-enhanced embed domain; can help with strict tracking protection. |

## Macro API

```js
const yt = game.modules.get("yt-music-player").api;
yt.play("https://www.youtube.com/playlist?list=PL...");   // replace queue and play
yt.add("https://youtu.be/dQw4w9WgXcQ");                   // append
yt.playSaved("Tavern");                                   // a saved playlist by name
yt.setRepeat("one");                                      // "off" | "all" | "one"
yt.togglePlay(); yt.next(); yt.previous(); yt.stop();
yt.setVolume(30);
yt.open(); yt.close(); yt.toggle();
```

## Browser notes (Firefox)

- Built and styled for Firefox first; Chromium and the Foundry desktop app also work.
- The hidden player is kept on the page but moved off-screen rather than hidden with `display: none`, because Firefox will not run a YouTube iframe that isn't laid out.
- Browsers block sound until you interact with the page. If a player joins while music is already playing, they get a notice and the music starts on their first click.
- If Firefox's **Strict** Enhanced Tracking Protection or an ad blocker stops the player from loading, allow `youtube.com` for your Foundry address or turn on *Use youtube-nocookie.com*.

## Limitations

- Each computer streams the audio from YouTube itself; sync is kept within about 3 seconds.
- Some videos (often official music videos) don't allow playback outside YouTube. They are marked in the queue and skipped automatically.
- YouTube only reports the first 200 videos of very long playlists.
- Private playlists and your personal *Watch Later* / *Liked videos* lists can't be loaded.
- Ads may play for viewers who aren't YouTube Premium subscribers, as in any YouTube embed.
- If several GMs are online with broadcasting on, the most recent GM to act is what players hear; have one GM drive the music.
