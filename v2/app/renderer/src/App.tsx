// The app shell: the sidebar, the screen beside it and Search over both. Each screen owns its folder under screens/.
import { useCallback, useEffect, useRef, useState } from 'react'
import { act, bridge, query, useQuery, useShell } from './lib/api.ts'
import { dateKey } from './lib/format.ts'
import { Apps, type AppsNav } from './screens/apps/Apps.tsx'
import { Ask } from './screens/ask/Ask.tsx'
import { AssistantRequests } from './screens/assistants/AssistantRequests.tsx'
import { Onboarding } from './screens/onboarding/Onboarding.tsx'
import { SearchOverlay } from './screens/search/Search.tsx'
import { opensSearch } from './screens/search/shortcut.ts'
import { Settings } from './screens/settings/Settings.tsx'
import { Today, type TodayNav } from './screens/today/Today.tsx'
import { Sidebar, type Screen } from './shell/Sidebar.tsx'
import { ToastHost, useToast } from './ui/overlays.tsx'

const marks: Record<string, number> = {}

export function App() {
  return (
    <ToastHost>
      <Shell />
    </ToastHost>
  )
}

function Shell() {
  const shell = useShell()
  const [screen, setScreen] = useState<Screen>('today')
  const [search, setSearch] = useState(false)
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [todayNav, setTodayNav] = useState<TodayNav>({ date: dateKey(new Date()), scope: 'day', openHour: null })
  const [appsNav, setAppsNav] = useState<AppsNav>({ date: dateKey(new Date()), scope: 'day', app: null })
  const { data: rec } = useQuery({ q: 'recording' }, { live: true })
  const toast = useToast()
  const benchRan = useRef(false)

  useEffect(() => {
    if (shell && onboarded === null) setOnboarded(shell.onboarded || shell.bench)
  }, [shell, onboarded])

  useEffect(
    () =>
      bridge.onNavigate((to) => {
        if (to === 'today') {
          setScreen('today')
          setTodayNav({ date: dateKey(new Date()), scope: 'day', openHour: null })
        }
        if (to === 'settings') setScreen('settings')
        if (to === 'search') setSearch(true)
        if (to === 'search-toggle') setSearch((s) => !s)
      }),
    [],
  )

  useEffect(() => bridge.onDeletionFailed(() => toast({ text: 'A deletion didn’t finish. Daylens will try again when it next starts.', error: true })), [toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (opensSearch(e, bridge.platform)) {
        e.preventDefault()
        setSearch((s) => !s)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onMark = useCallback((name: string) => {
    marks[name] ??= performance.now()
    window.dispatchEvent(new CustomEvent('daylens-mark', { detail: name }))
  }, [])

  useEffect(() => {
    if (!shell?.bench || benchRan.current) return
    benchRan.current = true
    void runBench({ setScreen, setTodayNav })
  }, [shell?.bench])

  if (onboarded === null) return <div className="window" />
  if (!onboarded)
    return (
      <div className="window">
        <main className="main">
          <Onboarding shell={shell} onDone={() => setOnboarded(true)} />
        </main>
      </div>
    )

  const go = (s: Screen) => {
    if (s === 'today') setTodayNav({ date: dateKey(new Date()), scope: 'day', openHour: null })
    setScreen(s)
  }

  return (
    <div className="window">
      <Sidebar screen={screen} onScreen={go} />
      <main className="main">
        {screen === 'today' && <Today nav={todayNav} setNav={setTodayNav} shell={shell} rec={rec} onMark={onMark} />}
        {screen === 'apps' && <Apps nav={appsNav} setNav={setAppsNav} firstDay={rec?.first_day ?? null} onMark={onMark} />}
        {screen === 'ask' && (
          <Ask
            onOpenHour={(start) => {
              setScreen('today')
              setTodayNav({ date: dateKey(new Date(start)), scope: 'day', openHour: start, jump: Date.now() })
            }}
          />
        )}
        {screen === 'settings' && <Settings shell={shell} rec={rec} />}
      </main>
      {search && (
        <SearchOverlay
          onClose={() => setSearch(false)}
          onOpenHour={(start) => {
            setScreen('today')
            setTodayNav({ date: dateKey(new Date(start)), scope: 'day', openHour: start, jump: Date.now() })
          }}
        />
      )}
      <AssistantRequests />
    </div>
  )
}

// DAYLENS_BENCH=1: times the first paint of Today, then each action from click to the frame that shows its result.
function nextMark(name: string): Promise<number> {
  return new Promise((resolve) => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail !== name) return
      window.removeEventListener('daylens-mark', on)
      requestAnimationFrame(() => resolve(performance.now()))
    }
    window.addEventListener('daylens-mark', on)
  })
}

async function runBench({ setScreen, setTodayNav }: { setScreen: (s: Screen) => void; setTodayNav: (n: TodayNav) => void }) {
  const out: Record<string, number> = {}
  const t0 = performance.timeOrigin
  if (marks.day_painted === undefined) await nextMark('day_painted')
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  out.today_painted_epoch_ms = t0 + (marks.day_painted ?? performance.now())
  out.renderer_nav_to_today_ms = marks.day_painted ?? -1
  const time = async (name: string, mark: string, run: () => void) => {
    const start = performance.now()
    const done = nextMark(mark)
    run()
    out[name] = (await done) - start
  }
  const today = dateKey(new Date())
  const yesterday = dateKey(new Date(Date.now() - 86_400_000))
  await time('switch_day_ms', 'day_painted', () => setTodayNav({ date: yesterday, scope: 'day', openHour: null }))
  await time('back_to_today_ms', 'day_painted', () => setTodayNav({ date: today, scope: 'day', openHour: null }))
  const hour = document.querySelector<HTMLElement>('[data-current="true"]')?.dataset.hour
  if (hour) await time('open_hour_ms', 'hour_painted', () => setTodayNav({ date: today, scope: 'day', openHour: Number(hour) }))
  await time('week_view_ms', 'week_painted', () => setTodayNav({ date: today, scope: 'week', openHour: null }))
  await time('month_view_ms', 'month_painted', () => setTodayNav({ date: today, scope: 'month', openHour: null }))
  await time('apps_view_ms', 'apps_painted', () => setScreen('apps'))
  for (const text of ['order', 'order form', 'invoice october']) {
    const start = performance.now()
    await query({ q: 'search', text, per_group: 5 })
    out[`search_${text.replace(/ /g, '_')}_ms`] = performance.now() - start
  }
  await act({ a: 'bench', marks: out })
}
