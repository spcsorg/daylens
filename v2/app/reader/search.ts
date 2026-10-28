// Search's reads, from the search index over the record.
import { search as find } from '../../retrieval/search.ts'
import type { SearchQuery } from '../shared/search.ts'
import type { Handlers } from './queries.ts'

export const search: Handlers<SearchQuery> = {
  // Past the retention period is hidden here as on every screen, before pruning reaches it.
  search: ({ record, finder }, q) => find(finder, q.text, { perGroup: q.per_group, fromWallMs: record.cutoff() ?? undefined }),
  search_warm: ({ finder }) => finder.warmSearch(),
}
