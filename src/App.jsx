import { useEffect, useRef, useState } from 'react'
import './App.css'

const MOCK_SONG_LIST = [
  'Song 1',
  'Song 2',
  'Song 3',
  'Song 4',
  'Song 5',
  'Song 6',
  'Song 7',
  'Song 8',
  'Song 9',
  'Song 10',
]

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
  }

  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function App() {
  const [connectionState, setConnectionState] = useState('loading')
  const [selectedIndex, setSelectedIndex] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const selectDebounceRef = useRef(null)

  const isConnected = connectionState === 'on'
  const isPowering =
    connectionState === 'powering-on' || connectionState === 'powering-off'
  const selectedSong = MOCK_SONG_LIST[selectedIndex] ?? null
  const hasQueuedSong = selectedIndex !== null && selectedSong

  useEffect(() => {
    const getStatus = async () => {
      try {
        const response = await fetch('/api/status')
        if (!response.ok) throw new Error('Status request failed')
        const status = await response.json()
        setConnectionState(status.powerOn ? 'on' : 'off')
        if (!status.powerOn) {
          setIsPlaying(false)
          setSelectedIndex(null)
        }
      } catch (error) {
        console.error('Failed to get ESP32 status:', error)
        setConnectionState('off')
      }
    }
    getStatus()
  }, [])

  const powerOn = async () => {
    if (isPowering || isConnected) return
    setConnectionState('powering-on')
    try {
      const response = await fetch('/api/power/on', { method: 'POST' })
      if (!response.ok) throw new Error('Power on request failed')
      const status = await response.json()
      setConnectionState(status.powerOn ? 'on' : 'off')
    } catch (error) {
      console.error('Failed to power on:', error)
      setConnectionState('off')
    }
  }

  const powerOff = async () => {
    if (isPowering || !isConnected) return
    setConnectionState('powering-off')
    try {
      const response = await fetch('/api/power/off', { method: 'POST' })
      if (!response.ok) throw new Error('Power off request failed')
      const status = await response.json()
      setIsPlaying(false)
      setSelectedIndex(null)
      setConnectionState(status.powerOn ? 'on' : 'off')
    } catch (error) {
      console.error('Failed to power off:', error)
      try {
        const response = await fetch('/api/status')
        const status = await response.json()
        setConnectionState(status.powerOn ? 'on' : 'off')
      } catch {
        setConnectionState('off')
      }
    }
  }

  const selectSong = (index) => {
    setSelectedIndex(index)
    setIsPlaying(true)

    clearTimeout(selectDebounceRef.current)
    selectDebounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          index: String(index),
          name: MOCK_SONG_LIST[index],
        })
        await fetch(`/api/select?${params}`, { method: 'POST' })
      } catch (error) {
        console.error('Failed to select song:', error)
      }
    }, 1000)
  }

  const moveToSong = (direction) => {
    const nextIndex =
      (selectedIndex + direction + MOCK_SONG_LIST.length) % MOCK_SONG_LIST.length
    selectSong(nextIndex)
  }

  const handlePlayPause = async () => {
    if (!hasQueuedSong) return
    const newPlaying = !isPlaying
    setIsPlaying(newPlaying)
    try {
      await fetch(newPlaying ? '/api/play' : '/api/pause', { method: 'POST' })
    } catch (error) {
      console.error('Failed to toggle playback:', error)
    }
  }

  const handleStop = async () => {
    setIsPlaying(false)
    setSelectedIndex(null)
    try {
      await fetch('/api/stop', { method: 'POST' })
    } catch (error) {
      console.error('Failed to stop:', error)
    }
  }

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
        <span className={isConnected ? 'connected' : ''} />
        {connectionState === 'loading'
          ? 'connecting...'
          : isConnected
            ? 'ready'
            : isPowering
              ? 'powering...'
              : 'offline'}
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
  )

  if (!isConnected) {
    return (
      <main className="player-shell power-shell">
        {topbar}
        <section className={`power-panel ${isPowering ? 'is-powering' : ''}`}>
          <button
            type="button"
            className="power-button"
            aria-label={isPowering ? 'Powering on' : 'Power on'}
            disabled={isPowering || connectionState === 'loading'}
            onClick={powerOn}
          >
            <Icon name="power" />
          </button>
          <p className="power-label">
            {connectionState === 'loading'
              ? 'Connecting...'
              : isPowering
                ? connectionState === 'powering-off'
                  ? 'Powering off'
                  : 'Powering on'
                : 'Tap to power on'}
          </p>
        </section>
      </main>
    )
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
            {hasQueuedSong ? (isPlaying ? 'NOW PLAYING' : 'PAUSED') : 'SELECT A SONG'}
          </p>
          <h2 id="now-playing-title">{selectedSong}</h2>
        </div>
        <div
          className={`equalizer ${isPlaying ? 'is-active' : ''}`}
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
          <span>{MOCK_SONG_LIST.length} tracks</span>
        </div>
        <div className="song-list" role="listbox" aria-label="Song library">
          {MOCK_SONG_LIST.map((song, index) => (
            <button
              className={`song-row ${index === selectedIndex ? 'is-selected' : ''}`}
              key={song}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              onClick={() => selectSong(index)}
            >
              <span className="song-number">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="song-name">{song}</span>
              {index === selectedIndex && (
                <span className="playing-dot" aria-label="Selected" />
              )}
            </button>
          ))}
        </div>
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
          aria-label={isPlaying ? 'Pause' : 'Play'}
          title={isPlaying ? 'Pause' : 'Play'}
          onClick={handlePlayPause}
        >
          <Icon name={isPlaying ? 'pause' : 'play'} />
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
  )
}

export default App
