// Evidence the engine reads from outside the capture database. Live readers are separate work; the gold-day replay
// feeds these from its frozen records.

export interface Commit {
  hash: string
  at_wall_ms: number
  // Repository folder names the commit was found in (one commit can be in several clones or worktrees).
  repos: string[]
  subject: string
  stat: string | null
}

export interface CommitSource {
  commits(fromWallMs: number, toWallMs: number): Commit[]
}

export interface CalendarEvent {
  id: string
  title: string
  start_wall_ms: number
  end_wall_ms: number
  attendees: number | null
}

export interface CalendarSource {
  events(fromWallMs: number, toWallMs: number): CalendarEvent[]
}
