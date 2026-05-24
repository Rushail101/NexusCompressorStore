import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/upload':   'http://localhost:5000',
      '/files':    'http://localhost:5000',
      '/stats':    'http://localhost:5000',
      '/download': 'http://localhost:5000',
      '/delete':   'http://localhost:5000',
      '/star':     'http://localhost:5000',
      '/trash':    'http://localhost:5000',
      '/restore':  'http://localhost:5000',
      '/health':   'http://localhost:5000',
      '/peers':    'http://localhost:5000',
      '/ml_status':'http://localhost:5000',
      '/ws': {
        target: 'ws://localhost:5000',
        ws: true,
      },
    },
  },
})
