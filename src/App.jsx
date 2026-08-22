import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

function Icon({ name }) {
  const paths = {
    play: <path d="m8 5 11 7-11 7V5Z" />,
    pause: <path d="M8 5v14M16 5v14" />,
    stop: <path d="M7 7h10v10H7z" />,
    previous: (
      <>
        <path d="m18 5-8 7 8 7V5Z" />
        <path d="M6 5v14" />
      </>
    ),
    next: (
      <>
        <path d="m6 5 8 7-8 7V5Z" />
        <path d="M18 5v14" />
      </>
    ),
    power: (
      <>
        <path d="M12 3v9" />
        <path d="M18.4 6.6a8.5 8.5 0 1 1-12.8 0" />
      </>
    ),
    music: (
      <>
        <path d="M9 18V5l10-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="16" cy="16" r="3" />
      </>
    ),
  };

  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function App() {
  const [connectionState, setConnectionState] = useState("loading");
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // null = still loading, [] = loaded (possibly empty), [...] = loaded with songs
  const [songs, setSongs] = useState(null);

  const selectDebounceRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const isConnected = connectionState === "on";
  const isPowering =
    connectionState === "powering-on" || connectionState === "powering-off";
  const selectedSong = songs?.[selectedIndex] ?? null;
  const hasQueuedSong = selectedIndex !== null && selectedSong;

  // Single source-of-truth for applying any status snapshot (HTTP or WS).
  // Stable reference — only uses setState functions which never change.
  const applyStatus = useCallback((status) => {
    setConnectionState(status.powerOn ? "on" : "off");
    if (status.powerOn) {
      setIsPlaying(status.playing ?? false);
      setSelectedIndex(
        status.hasSong && status.songIndex >= 0 ? status.songIndex : null
      );
    } else {
      setIsPlaying(false);
      setSelectedIndex(null);
    }
  }, []);

  const fetchStatus = useCallback(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => {});
  }, [applyStatus]);

  // WebSocket — real-time push from the ESP32.
  // Re-syncs via HTTP on every (re)connect to catch any missed events.
  useEffect(() => {
    function connect() {
      const socket = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = socket;

      socket.onopen = () => {
        clearTimeout(reconnectTimerRef.current);
        // The ESP32 sends current state on connect, but also fetch over HTTP
        // as a belt-and-suspenders guard against a race on the WS send.
        fetchStatus();
      };

      socket.onmessage = (event) => {
        try {
          applyStatus(JSON.parse(event.data));
        } catch {
          // Malformed frame — ignore and wait for next one.
        }
      };

      socket.onclose = () => {
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      // onerror always fires before onclose, so just let onclose handle retry.
      socket.onerror = () => {};
    }

    connect();

    return () => {
      clearTimeout(reconnectTimerRef.current);
      const s = wsRef.current;
      if (s) {
        s.onclose = null; // prevent reconnect loop on unmount
        s.close();
      }
    };
  }, [applyStatus, fetchStatus]);

  // Re-sync when the tab becomes visible again after being hidden —
  // covers the case where the user switched away and missed WS messages.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") fetchStatus();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [fetchStatus]);

  // Periodic heartbeat: catches any de-sync that WS and visibility didn't.
  useEffect(() => {
    const id = setInterval(fetchStatus, 30_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Fetch songs once on mount (song list doesn't change at runtime).
  useEffect(() => {
    fetch("/api/songs")
      .then((r) => r.json())
      .then((data) => setSongs(data.songs ?? []))
      .catch(() => setSongs([]));
  }, []);

  const powerOn = async () => {
    if (isPowering || isConnected) return;
    setConnectionState("powering-on");
    try {
      const response = await fetch("/api/power/on", { method: "POST" });
      if (!response.ok) throw new Error("Power on request failed");
      const status = await response.json();
      setConnectionState(status.powerOn ? "on" : "off");
    } catch (error) {
      console.error("Failed to power on:", error);
      setConnectionState("off");
    }
  };

  const powerOff = async () => {
    if (isPowering || !isConnected) return;
    setConnectionState("powering-off");
    try {
      const response = await fetch("/api/power/off", { method: "POST" });
      if (!response.ok) throw new Error("Power off request failed");
      const status = await response.json();
      setIsPlaying(false);
      setSelectedIndex(null);
      setConnectionState(status.powerOn ? "on" : "off");
    } catch (error) {
      console.error("Failed to power off:", error);
      fetchStatus();
    }
  };

  const selectSong = (index, songName) => {
    setSelectedIndex(index);
    setIsPlaying(true);

    clearTimeout(selectDebounceRef.current);
    selectDebounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          index: String(index),
          name: songName,
        });
        await fetch(`/api/select?${params}`, { method: "POST" });
      } catch (error) {
        console.error("Failed to select song:", error);
      }
    }, 1000);
  };

  const moveToSong = (direction) => {
    if (!songs || songs.length === 0) return;
    const nextIndex = (selectedIndex + direction + songs.length) % songs.length;
    selectSong(nextIndex, songs[nextIndex]);
  };

  const handlePlayPause = async () => {
    if (!hasQueuedSong) return;
    const newPlaying = !isPlaying;
    setIsPlaying(newPlaying);
    try {
      await fetch(newPlaying ? "/api/play" : "/api/pause", { method: "POST" });
    } catch (error) {
      console.error("Failed to toggle playback:", error);
    }
  };

  const handleStop = async () => {
    setIsPlaying(false);
    setSelectedIndex(null);
    try {
      await fetch("/api/stop", { method: "POST" });
    } catch (error) {
      console.error("Failed to stop:", error);
    }
  };

  const topbar = (
    <header className="topbar">
      <div className="brand-mark">
        <Icon name="music" />
      </div>
      <div>
        <p className="eyebrow">Mari and Hana&apos;s</p>
        <h1>Musicbox</h1>
      </div>
      <span className="connection-status">
        <span className={isConnected ? "connected" : ""} />
        {connectionState === "loading"
          ? "connecting..."
          : isConnected
            ? "ready"
            : isPowering
              ? "powering..."
              : "offline"}
      </span>
      {isConnected && (
        <button
          type="button"
          className="power-off-button"
          aria-label="Power off"
          title="Power off"
          onClick={powerOff}
          disabled={isPowering}
        >
          <Icon name="power" />
        </button>
      )}
    </header>
  );

  if (!isConnected) {
    return (
      <main className="player-shell power-shell">
        {topbar}
        <section className={`power-panel ${isPowering ? "is-powering" : ""}`}>
          <button
            type="button"
            className="power-button"
            aria-label={isPowering ? "Powering on" : "Power on"}
            disabled={isPowering || connectionState === "loading"}
            onClick={powerOn}
          >
            <Icon name="power" />
          </button>
          <p className="power-label">
            {connectionState === "loading"
              ? "Connecting..."
              : isPowering
                ? connectionState === "powering-off"
                  ? "Powering off"
                  : "Powering on"
                : "Tap to power on"}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="player-shell">
      {topbar}
      <section className="now-playing" aria-labelledby="now-playing-title">
        <div className="record-art">
          <Icon name="music" />
        </div>
        <div className="track-meta">
          <p className="eyebrow">
            {hasQueuedSong
              ? isPlaying
                ? "NOW PLAYING"
                : "PAUSED"
              : "SELECT A SONG"}
          </p>
          <h2 id="now-playing-title">{selectedSong}</h2>
        </div>
        <div
          className={`equalizer ${isPlaying ? "is-active" : ""}`}
          aria-hidden="true"
        >
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>
      <section className="library" aria-labelledby="library-title">
        <div className="section-heading">
          <h2 id="library-title">Library</h2>
          <span>{songs === null ? "—" : songs.length} tracks</span>
        </div>
        {songs === null ? (
          <div
            className="song-list-spinner"
            role="status"
            aria-label="Loading songs"
          />
        ) : songs.length === 0 ? (
          <p className="song-list-empty">No songs found on SD card</p>
        ) : (
          <div className="song-list" role="listbox" aria-label="Song library">
            {songs.map((song, index) => (
              <button
                className={`song-row ${index === selectedIndex ? "is-selected" : ""}`}
                key={song}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                onClick={() => selectSong(index, song)}
              >
                <span className="song-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="song-name">{song}</span>
                {index === selectedIndex && (
                  <span className="playing-dot" aria-label="Selected" />
                )}
              </button>
            ))}
          </div>
        )}
      </section>
      <footer className="controls" aria-label="Playback controls">
        <button
          disabled={!isConnected}
          type="button"
          className="control-button"
          aria-label="Previous song"
          title="Previous song"
          onClick={() => moveToSong(-1)}
        >
          <Icon name="previous" />
        </button>
        <button
          disabled={!isConnected}
          type="button"
          className="control-button control-button--primary"
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause" : "Play"}
          onClick={handlePlayPause}
        >
          <Icon name={isPlaying ? "pause" : "play"} />
        </button>
        <button
          disabled={!isConnected}
          type="button"
          className="control-button"
          aria-label="Next song"
          title="Next song"
          onClick={() => moveToSong(1)}
        >
          <Icon name="next" />
        </button>
        <button
          disabled={!isConnected}
          type="button"
          className="control-button control-button--stop"
          aria-label="Stop"
          title="Stop"
          onClick={handleStop}
        >
          <Icon name="stop" />
        </button>
      </footer>
    </main>
  );
}

export default App;
