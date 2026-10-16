export interface ExclusionRule {
  // `site` matches a page host and every subdomain of it.
  match: 'app_id' | 'exe' | 'site'
  value: string
  label: string
}

// Web vaults of the password managers below. Banking sites depend on the country and are not seeded.
export const DEFAULT_SITE_EXCLUSIONS: readonly ExclusionRule[] = [
  { match: 'site', value: '1password.com', label: '1Password' },
  { match: 'site', value: '1password.eu', label: '1Password' },
  { match: 'site', value: '1password.ca', label: '1Password' },
  { match: 'site', value: 'bitwarden.com', label: 'Bitwarden' },
  { match: 'site', value: 'bitwarden.eu', label: 'Bitwarden' },
  { match: 'site', value: 'dashlane.com', label: 'Dashlane' },
  { match: 'site', value: 'lastpass.com', label: 'LastPass' },
  { match: 'site', value: 'lastpass.eu', label: 'LastPass' },
  { match: 'site', value: 'pass.proton.me', label: 'Proton Pass' },
]

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
  ...DEFAULT_SITE_EXCLUSIONS,
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
    'com.openai.atlas',
    'com.openai.atlas.beta',
    'com.openai.chatgpt.atlas',
  ].map((s) => s.toLowerCase()),
)

// Apps that register as http/https handlers but whose window titles are the work context, not browsing.
// Codex (com.openai.codex) embeds ordinary, non-private pages; its titles are kept. Capture stores no addresses
// from any app, and when browser pages arrive Codex must not become a page source. Exclusions still apply,
// and a window reported in private mode is withheld (normalize.ts). The known-browser list above wins over this one.
export const KNOWN_NON_BROWSER_APP_IDS: ReadonlySet<string> = new Set(['com.openai.codex'].map((s) => s.toLowerCase()))

// Apps whose bundle names itself after a different product.
export const DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([['com.openai.codex', 'Codex']])

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
