import { useState } from 'react'
import './App.css'

const MOCK_SONG_LIST = [
  'Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5',
  'Song 6', 'Song 7', 'Song 8', 'Song 9', 'Song 10',
]

function Icon({ name }) {
  const paths = {
    play: <path d="m8 5 11 7-11 7V5Z" />,
    pause: <path d="M8 5v14M16 5v14" />,
    stop: <path d="M7 7h10v10H7z" />,
    previous: <><path d="m18 5-8 7 8 7V5Z" /><path d="M6 5v14" /></>,
    next: <><path d="m6 5 8 7-8 7V5Z" /><path d="M18 5v14" /></>,
    music: <><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></>,
  }

  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function App() {
  const [isConnected, setIsConnected] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const selectedSong = MOCK_SONG_LIST[selectedIndex] ?? null
  const hasQueuedSong = selectedIndex !== null && selectedSong

  const selectSong = (index) => {
    setSelectedIndex(index)
    setIsPlaying(true)
  }

  const moveToSong = (direction) => {
    const nextIndex = (selectedIndex + direction + MOCK_SONG_LIST.length) % MOCK_SONG_LIST.length
    selectSong(nextIndex)
  }

  const handlePlayPause = () => {
    if (hasQueuedSong) {
      setIsPlaying(!isPlaying)
    }
  }

  return (
    <main className="player-shell">
      <header className="topbar">
        <div className="brand-mark"><Icon name="music" /></div>
        <div><p className="eyebrow">Mari and Hana's</p><h1>Musicbox</h1></div>
        <span className="connection-status">
          <span className={isConnected ? 'connected' : ''}/>
          {isConnected ? 'ready' : 'connecting...'}
        </span>
      </header>

      <section className="now-playing" aria-labelledby="now-playing-title">
        <div className="record-art"><Icon name="music" /></div>
        <div className="track-meta">
          <p className="eyebrow">{hasQueuedSong ? (isPlaying ? 'NOW PLAYING' : 'PAUSED') : 'SELECT A SONG'}</p>
          <h2 id="now-playing-title">{selectedSong}</h2>
          {/* <p className="track-status">{isPlaying ? 'Playing from Musicbox' : 'Paused'}</p> */}
        </div>
        <div className={`equalizer ${isPlaying ? 'is-active' : ''}`} aria-hidden="true"><i /><i /><i /><i /></div>
      </section>

      <section className="library" aria-labelledby="library-title">
        <div className="section-heading"><h2 id="library-title">Library</h2><span>{MOCK_SONG_LIST.length} tracks</span></div>
        <div className="song-list" role="listbox" aria-label="Song library">
          {MOCK_SONG_LIST.map((song, index) => (
            <button className={`song-row ${index === selectedIndex ? 'is-selected' : ''}`} key={song} type="button" role="option" aria-selected={index === selectedIndex} onClick={() => selectSong(index)}>
              <span className="song-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="song-name">{song}</span>
              {index === selectedIndex && <span className="playing-dot" aria-label="Selected" />}
            </button>
          ))}
        </div>
      </section>

      <footer className="controls" aria-label="Playback controls">
        <button disabled={!isConnected} type="button" className="control-button" aria-label="Previous song" title="Previous song" onClick={() => moveToSong(-1)}><Icon name="previous" /></button>
        <button disabled={!isConnected} type="button" className="control-button control-button--primary" aria-label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause' : 'Play'} onClick={handlePlayPause}><Icon name={isPlaying ? 'pause' : 'play'} /></button>
        <button disabled={!isConnected} type="button" className="control-button" aria-label="Next song" title="Next song" onClick={() => moveToSong(1)}><Icon name="next" /></button>
        <button disabled={!isConnected} type="button" className="control-button control-button--stop" aria-label="Stop" title="Stop" onClick={() => { setIsPlaying(false); setSelectedIndex(null); }}><Icon name="stop" /></button>
      </footer>
    </main>
  )
}

export default App
