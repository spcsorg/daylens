// Renders dmg-background.html to dmg-background.png and dmg-background@2x.png.
// Usage: node_modules/.bin/electron app/package/dmg-background.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadFile(path.join(__dirname, 'dmg-background.html'))
  for (const [scale, name] of [[1, 'dmg-background.png'], [2, 'dmg-background@2x.png']]) {
    const url = await win.webContents.executeJavaScript(`render(${scale})`)
    writeFileSync(path.join(__dirname, name), Buffer.from(url.split(',')[1], 'base64'))
  }
  app.quit()
})
