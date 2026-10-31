import { useState } from 'react'
import { useQuery } from '../lib/api.ts'
import { addMonths, dateKey, monthOf, monthTitle, parseKey } from '../lib/format.ts'
import { IconButton } from './controls.tsx'

/** Days from the first recorded one to today; today is marked. */
export function CalendarPicker({ selected, today, firstDay, onPick }: { selected: string; today: string; firstDay: string | null; onPick: (date: string) => void }) {
  const [month, setMonth] = useState(monthOf(selected))
  const { data: recorded } = useQuery({ q: 'recorded_days', month })
  const marks = new Set(recorded ?? [])
  const first = parseKey(`${month}-01`)
  const lead = (first.getDay() + 6) % 7
  const days: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = new Date(first); d.getMonth() === first.getMonth(); d.setDate(d.getDate() + 1)) days.push(dateKey(d))
  return (
    <div className="calendar">
      <div className="calendar-head">
        <span className="grow">{monthTitle(month)}</span>
        <IconButton icon="chevron-left" label="Previous month" disabled={firstDay === null || month <= monthOf(firstDay)} onClick={() => setMonth(addMonths(month, -1))} />
        <IconButton icon="chevron-right" label="Next month" disabled={month >= monthOf(today)} onClick={() => setMonth(addMonths(month, 1))} />
      </div>
      <div className="calendar-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="dow">
            {d}
          </span>
        ))}
        {days.map((d, i) =>
          d === null ? (
            <span key={`e${i}`} />
          ) : (
            <button
              key={d}
              className={`${d === selected ? 'selected' : ''} ${marks.has(d) ? 'recorded' : ''} ${d === today ? 'today' : ''}`}
              disabled={d > today || firstDay === null || d < firstDay}
              aria-label={`${d}${d === today ? ', today' : ''}${marks.has(d) ? ', recorded' : ''}`}
              onClick={() => onPick(d)}
            >
              {parseKey(d).getDate()}
            </button>
          ),
        )}
      </div>
    </div>
  )
}
