// Shared styles load before any screen's, so a screen's stylesheet can build on them.
import './styles/tokens.css'
import './styles/base.css'
import './ui/ui.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { bridge } from './lib/api.ts'

document.documentElement.dataset.platform = bridge.platform

// The theme follows the shell's choice; "system" follows the operating system as it changes.
const media = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => {
  document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
}
applyTheme()
media.addEventListener('change', applyTheme)

// The window shows on its first paint; waiting for the two faces (local files, a few ms) keeps that paint in the right type.
void Promise.all([document.fonts.load('400 14px Geist'), document.fonts.load('400 28px "Hedvig Letters Serif"')])
  .catch(() => {})
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
