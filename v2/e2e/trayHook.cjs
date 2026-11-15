// Loaded before main (`-r`): keeps each Tray that gets a click listener where the tray test can reach it, since main
// holds its Tray in a module variable.
const { Tray } = require('electron')
const on = Tray.prototype.on
Tray.prototype.on = function (event, listener) {
  if (event === 'click') (globalThis.e2eTrays ??= []).push(this)
  return on.call(this, event, listener)
}
