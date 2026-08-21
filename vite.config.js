import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

function mockApiPlugin() {
  const state = {
    powerOn: false,
    filename: '',
    isPlaying: false,
    hasSong: false,
    songIndex: -1,
    progress: 0,
  }

  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/')) return next()

        const url = new URL(req.url, 'http://localhost')
        const path = url.pathname

        const send = (obj) => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.statusCode = 200
          res.end(JSON.stringify(obj))
        }

        if (path === '/api/status' && req.method === 'GET') {
          send({
            powerOn: state.powerOn,
            filename: state.filename,
            progress: state.progress,
            playing: state.isPlaying,
            hasSong: state.hasSong,
            songIndex: state.songIndex,
            wifi: true,
          })
        } else if (path === '/api/power/on' && req.method === 'POST') {
          state.powerOn = true
          send({ powerOn: true })
        } else if (path === '/api/power/off' && req.method === 'POST') {
          state.powerOn = false
          state.isPlaying = false
          state.hasSong = false
          state.songIndex = -1
          state.filename = ''
          state.progress = 0
          send({ powerOn: false })
        } else if (path === '/api/select' && req.method === 'POST') {
          state.filename = url.searchParams.get('name') ?? ''
          state.songIndex = parseInt(url.searchParams.get('index') ?? '-1', 10)
          state.hasSong = true
          state.isPlaying = true
          state.progress = 0
          send({ ok: true })
        } else if (path === '/api/play' && req.method === 'POST') {
          if (state.hasSong) state.isPlaying = true
          send({ ok: true })
        } else if (path === '/api/pause' && req.method === 'POST') {
          state.isPlaying = false
          send({ ok: true })
        } else if (path === '/api/stop' && req.method === 'POST') {
          state.isPlaying = false
          state.hasSong = false
          state.songIndex = -1
          state.filename = ''
          state.progress = 0
          send({ ok: true })
        } else {
          next()
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    mockApiPlugin(),
  ],
})
