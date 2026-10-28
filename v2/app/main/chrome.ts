// The window's frame on each platform (docs/experience.md, Platform differences). macOS draws its traffic lights inside
// the sidebar; Windows draws its caption buttons over the top right in Daylens colours, so Snap layouts still work;
// Linux keeps the desktop's own frame.
import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

// tokens.css --bg-window and --text-2, light and dark.
const PAGE = { light: { bg: '#ffffff', symbols: '#4b5158' }, dark: { bg: '#141619', symbols: '#b4b9bf' } }
// Matches .header's top padding, so the caption buttons never sit over a screen's own controls.
const CONTROLS_HEIGHT = 36

function page() {
  return nativeTheme.shouldUseDarkColors ? PAGE.dark : PAGE.light
}

export function chrome(): BrowserWindowConstructorOptions {
  const p = page()
  if (process.platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 14 }, backgroundColor: p.bg }
  if (process.platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: p.bg, symbolColor: p.symbols, height: CONTROLS_HEIGHT }, backgroundColor: p.bg }
  return { backgroundColor: p.bg }
}

/** Keeps the frame in step with the theme as it changes. */
export function followTheme(win: BrowserWindow): () => void {
  const update = () => {
    const p = page()
    win.setBackgroundColor(p.bg)
    if (process.platform === 'win32') win.setTitleBarOverlay({ color: p.bg, symbolColor: p.symbols, height: CONTROLS_HEIGHT })
  }
  nativeTheme.on('updated', update)
  return () => nativeTheme.off('updated', update)
}
