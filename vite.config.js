import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api': 'https://music.163.com'
    }
  }
})