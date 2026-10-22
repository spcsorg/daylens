// How long the deletion worker may commit nothing while it has work before capture takes checkpointing back from it.
export const DELETION_STALL_MS = 60_000

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

// Apps that ship a browser engine (Chromium, Gecko, Electron, CEF) but are not browsers. Files cannot prove
// that (an Electron app can be a browser with private tabs), so only these keep their titles, and only when
// both the app ID and the OS-verified signer match: macOS bundle ID + Team ID; a Windows package (whose
// identity is bound to its publisher); or a Windows executable + Authenticode publisher. Never a name alone.
// Codex (com.openai.codex) embeds ordinary, non-private pages; its titles are kept. Capture stores no addresses
// from any app. Exclusions still apply, and a window reported in private mode is withheld (normalize.ts).
export interface TrustedApp {
  label: string
  app_id?: string
  exe?: string
  signer?: string
  // Windows executables: the version resource's ProductName must match too (or its OriginalFilename must equal exe).
  product?: string
  // Registered http/https handlers are never exempted, except where Tonny decided otherwise (Codex, 2026-10-16).
  registers_links?: true
  // Team IDs and publishers not read from an installed copy yet; a wrong value only withholds that app's titles.
  unverified?: true
}

export const TRUSTED_WEB_RUNTIME_APPS: readonly TrustedApp[] = [
  // macOS: bundle ID + Team ID
  { label: 'Slack', app_id: 'com.tinyspeck.slackmacgap', signer: 'BQR82RBBHL', unverified: true },
  { label: 'Visual Studio Code', app_id: 'com.microsoft.VSCode', signer: 'UBF8T346G9', unverified: true },
  { label: 'Cursor', app_id: 'com.todesktop.230313mzl4w4u92', signer: 'VDXQ22DGB9' },
  { label: 'Discord', app_id: 'com.hnc.Discord', signer: '53Q6R32WPB', unverified: true },
  { label: 'Notion', app_id: 'notion.id', signer: 'LBQJ96FQ8D' },
  { label: 'Figma', app_id: 'com.figma.Desktop', signer: 'T8RA8NE3B7' },
  { label: 'Linear', app_id: 'com.linear', signer: '7VZ2S3V9RV' },
  { label: 'Obsidian', app_id: 'md.obsidian', signer: '6JSW4SJWN9' },
  { label: 'Spotify', app_id: 'com.spotify.client', signer: '2FNC3A47ZF' },
  { label: 'WhatsApp', app_id: 'net.whatsapp.WhatsApp', signer: '57T9237FN3', unverified: true },
  { label: 'Microsoft Teams', app_id: 'com.microsoft.teams2', signer: 'UBF8T346G9' },
  { label: 'Claude', app_id: 'com.anthropic.claudefordesktop', signer: 'Q6L2SF6YDW' },
  { label: 'ChatGPT / Codex', app_id: 'com.openai.codex', signer: '2DC432GLL2', registers_links: true },
  { label: 'Daylens', app_id: 'com.daylens.desktop', signer: '9AVJWGP6MS' },
  // Windows packages: the package family name carries the publisher's identity
  { label: 'Microsoft Teams', app_id: 'MSTeams_8wekyb3d8bbwe!MSTeams', unverified: true },
  { label: 'WhatsApp', app_id: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', unverified: true },
  { label: 'Spotify', app_id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', unverified: true },
  // Windows executables: file name + Authenticode publisher
  { label: 'Slack', exe: 'slack.exe', signer: 'Slack Technologies, LLC', product: 'Slack', unverified: true },
  { label: 'Visual Studio Code', exe: 'code.exe', signer: 'Microsoft Corporation', product: 'Visual Studio Code', unverified: true },
  { label: 'Cursor', exe: 'cursor.exe', signer: 'Anysphere, Inc.', product: 'Cursor', unverified: true },
  { label: 'Discord', exe: 'discord.exe', signer: 'Discord Inc.', product: 'Discord', unverified: true },
  { label: 'Notion', exe: 'notion.exe', signer: 'Notion Labs, Inc.', product: 'Notion', unverified: true },
  { label: 'Figma', exe: 'figma.exe', signer: 'Figma, Inc.', product: 'Figma', unverified: true },
  { label: 'Linear', exe: 'linear.exe', signer: 'Linear Orbit, Inc.', product: 'Linear', unverified: true },
  { label: 'Obsidian', exe: 'obsidian.exe', signer: 'Dynalist Inc.', product: 'Obsidian', unverified: true },
  { label: 'Spotify', exe: 'spotify.exe', signer: 'Spotify AB', product: 'Spotify', unverified: true },
  { label: 'Claude', exe: 'claude.exe', signer: 'Anthropic, PBC', product: 'Claude', unverified: true },
  { label: 'ChatGPT / Codex', exe: 'chatgpt.exe', signer: 'OpenAI OpCo, LLC', product: 'ChatGPT', registers_links: true, unverified: true },
]

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
