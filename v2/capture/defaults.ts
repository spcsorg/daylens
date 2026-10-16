export interface ExclusionRule {
  match: 'app_id' | 'exe'
  value: string
  label: string
}

export const DEFAULT_EXCLUSIONS: readonly ExclusionRule[] = [
  { match: 'app_id', value: 'com.1password.1password', label: '1Password' },
  { match: 'app_id', value: 'com.agilebits.onepassword7', label: '1Password 7' },
  { match: 'exe', value: '1password.exe', label: '1Password' },
  { match: 'app_id', value: 'com.bitwarden.desktop', label: 'Bitwarden' },
  { match: 'exe', value: 'bitwarden.exe', label: 'Bitwarden' },
  { match: 'app_id', value: 'org.keepassxc.keepassxc', label: 'KeePassXC' },
  { match: 'exe', value: 'keepassxc.exe', label: 'KeePassXC' },
  { match: 'exe', value: 'keepass.exe', label: 'KeePass' },
  { match: 'app_id', value: 'com.apple.keychainaccess', label: 'Keychain Access' },
  { match: 'app_id', value: 'com.apple.Passwords', label: 'Passwords' },
  { match: 'app_id', value: 'com.dashlane.dashlanephonefinal', label: 'Dashlane' },
  { match: 'exe', value: 'dashlane.exe', label: 'Dashlane' },
  { match: 'app_id', value: 'com.lastpass.lastpassmacdesktop', label: 'LastPass' },
  { match: 'exe', value: 'lastpass.exe', label: 'LastPass' },
  { match: 'app_id', value: 'me.proton.pass.electron', label: 'Proton Pass' },
  { match: 'exe', value: 'proton pass.exe', label: 'Proton Pass' },
  { match: 'app_id', value: 'in.sinew.Enpass-Desktop', label: 'Enpass' },
  { match: 'exe', value: 'enpass.exe', label: 'Enpass' },
]

// Browsers that may not register as http/https handlers on every install.
export const KNOWN_BROWSER_APP_IDS: ReadonlySet<string> = new Set(
  [
    'com.apple.Safari',
    'com.apple.SafariTechnologyPreview',
    'com.google.Chrome',
    'com.google.Chrome.beta',
    'com.google.Chrome.canary',
    'org.chromium.Chromium',
    'com.microsoft.edgemac',
    'com.microsoft.edgemac.Beta',
    'org.mozilla.firefox',
    'org.mozilla.firefoxdeveloperedition',
    'org.mozilla.nightly',
    'company.thebrowser.Browser',
    'company.thebrowser.dia',
    'com.brave.Browser',
    'com.operasoftware.Opera',
    'com.operasoftware.OperaGX',
    'com.vivaldi.Vivaldi',
    'app.zen-browser.zen',
    'ai.perplexity.comet',
    'com.kagi.kagimacOS',
    'org.torproject.torbrowser',
    'io.gitlab.librewolf-community',
    'net.waterfox.waterfox',
    'com.duckduckgo.macos.browser',
    'net.mullvad.mullvadbrowser',
    'org.mozilla.librewolf',
  ].map((s) => s.toLowerCase()),
)

export const KNOWN_BROWSER_EXES: ReadonlySet<string> = new Set([
  'chrome.exe',
  'chromium.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'opera.exe',
  'opera_gx.exe',
  'vivaldi.exe',
  'arc.exe',
  'dia.exe',
  'zen.exe',
  'comet.exe',
  'librewolf.exe',
  'waterfox.exe',
  'floorp.exe',
  'thorium.exe',
  'iexplore.exe',
  'tor.exe',
  'duckduckgo.exe',
  'mullvadbrowser.exe',
])
