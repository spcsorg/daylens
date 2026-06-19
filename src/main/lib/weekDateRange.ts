export function buildWeekDateRange(weekStartStr: string): { weekStart: string; weekEnd: string; dates: string[] } {
  const [year, month, day] = weekStartStr.split('-').map(Number)
  const start = new Date(year, month - 1, day)
  const dates = Array.from({ length: 7 }, (_, index) => {
    const next = new Date(start)
    next.setDate(start.getDate() + index)
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
  })
  return {
    weekStart: dates[0],
    weekEnd: dates[dates.length - 1],
    dates,
  }
}
