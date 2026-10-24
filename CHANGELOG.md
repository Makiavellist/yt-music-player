# Changelog

## 1.0.0

First release of **YouTube Music Player** for Foundry VTT v13 (verified on 13.351). System-agnostic, no API key needed.

**Install:** in Foundry's setup screen go to *Add-on Modules → Install Module* and paste the manifest URL:

```
https://github.com/Makiavellist/yt-music-player/releases/latest/download/module.json
```

- Play any YouTube video link, or load a whole YouTube playlist into the queue
- Repeat off / whole queue / single song
- Click any track to switch to it; drag to reorder, shuffle, remove, clear
- Seek bar, previous / play-pause / stop / next, per-computer volume
- Save queues as named playlists and load them later
- GM broadcast mode: the GM's music plays in sync for every player (players can opt out)
- Macro API: `game.modules.get("yt-music-player").api`
- Built for Firefox first; Chromium and the Foundry desktop app also work
