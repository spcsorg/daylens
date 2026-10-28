// Search's reads: results across every day, and a warm-up when the overlay opens.
import type { SearchResults } from '../../retrieval/search.ts'

export type { FoundHour, FoundItem, SearchResults } from '../../retrieval/search.ts'

export type SearchQuery = { q: 'search'; text: string; per_group: number } | { q: 'search_warm' }

export interface SearchResultsByQuery {
  search: SearchResults
  search_warm: number
}
