import { Icon, type IconName } from '../ui/Icon.tsx'
import './shell.css'

export type Screen = 'today' | 'apps' | 'ask' | 'settings'

function Item({ icon, label, current, onClick }: { icon: IconName; label: string; current: boolean; onClick: () => void }) {
  return (
    <button type="button" className="nav" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} filled={current} />
      {label}
    </button>
  )
}

export function Sidebar({ screen, onScreen }: { screen: Screen; onScreen: (s: Screen) => void }) {
  const place = (s: Screen, icon: IconName, label: string) => <Item icon={icon} label={label} current={screen === s} onClick={() => onScreen(s)} />
  return (
    <nav className="sidebar">
      {place('today', 'today', 'Today')}
      {place('apps', 'apps', 'Apps')}
      {place('ask', 'ask', 'Ask')}
      <div className="spacer" />
      {place('settings', 'settings', 'Settings')}
    </nav>
  )
}
