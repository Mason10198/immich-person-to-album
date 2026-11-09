import { addAssetsToAlbum, init, removeAssetFromAlbum, searchAssets } from '@immich/sdk'
import { PersonToAlbum } from './function'
import { Link, User } from './types'

interface Participant {
  user: User;
  link: Link;
}

interface AlbumRunResult {
  albumId: string;
  success: boolean;
  error?: string;
}

const BATCH_SIZE = 500

/**
 * Full reconciliation adapts mafr95/immich-person-to-album@646ab4949f33.
 * Unlike its per-link cleanup, always reconcile every contributor's union.
 * See docs/PROVENANCE.md; license remains AGPL-3.0.
 */
export class AlbumSync {
  private running = false

  constructor (private pta: PersonToAlbum) {}

  async run (): Promise<AlbumRunResult[]> {
    // The SDK's active key is global. Overlapping cycles must never swap keys.
    if (this.running) {
      console.log('Previous album run is still active; skipping overlapping run')
      return []
    }
    this.running = true
    try {
      const groups = new Map<string, Participant[]>()
      for (const user of this.pta.config.users) {
        for (const original of user.personLinks) {
          const link = { ...original, apiKeyShort: user.apiKey.slice(0, 6) }
          const entries = groups.get(link.albumId) || []
          entries.push({ user, link })
          groups.set(link.albumId, entries)
        }
      }
      const results: AlbumRunResult[] = []
      for (const [albumId, entries] of groups) {
        try {
          if (entries.some(({ link }) => link.sync !== undefined && typeof link.sync !== 'boolean')) {
            throw new Error('sync must be a boolean')
          }
          if (entries.some(({ link }) => link.sync === true)) {
            if (!entries.every(({ link }) => link.sync === true)) {
              throw new Error('Every rule targeting a synchronized album must set sync: true')
            }
            await this.reconcile(entries)
          } else {
            // Ordinary albums keep the existing add-only behavior.
            let failed = false
            for (const entry of entries) {
              this.bind(entry)
              try {
                await this.pta.processPerson(entry.link)
              } catch (error) {
                failed = true
                console.error(`Add-only album ${albumId} rule failed: ${this.message(error)}`)
              }
            }
            if (failed) throw new Error('One or more add-only rules failed')
          }
          results.push({ albumId, success: true })
        } catch (error) {
          const message = this.message(error)
          console.error(`Album ${albumId} failed; no further cleanup: ${message}`)
          results.push({ albumId, success: false, error: message })
        }
      }
      return results
    } finally {
      this.running = false
    }
  }

  private bind ({ user }: Participant) {
    init({ baseUrl: this.pta.config.immichServer + '/api', apiKey: user.apiKey })
  }

  private message (error: unknown): string {
    return error instanceof Error ? error.message : 'Request failed'
  }

  private async reconcile (entries: Participant[]) {
    const wanted = new Set<string>()
    const contributions: { entry: Participant; ids: Set<string> }[] = []
    // No album writes at all until every contributor has completed a full scan.
    for (const entry of entries) {
      this.bind(entry)
      const ids = new Set(await this.pta.getMatchingAssetIds(entry.link))
      for (const id of ids) {
        if (typeof id !== 'string' || !id.length) throw new Error('Incomplete matching asset IDs')
        wanted.add(id)
      }
      contributions.push({ entry, ids })
    }

    const owner = entries[0] // Configure the album owner's account first.
    const albumId = owner.link.albumId
    this.bind(owner)
    const current = await this.getAlbumAssetIds(albumId)
    const present = new Set(current)
    let added = 0
    for (const { entry, ids } of contributions) {
      this.bind(entry)
      const missing = [...ids].filter(id => !present.has(id))
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE)
        const results = await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: batch } })
        this.checkResults(results, batch, true)
        batch.forEach(id => present.add(id))
        added += batch.length
      }
    }

    // Only successful complete scans and additions can reach membership removal.
    this.bind(owner)
    const stale = [...current].filter(id => !wanted.has(id))
    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      const batch = stale.slice(i, i + BATCH_SIZE)
      const results = await removeAssetFromAlbum({ id: albumId, bulkIdsDto: { ids: batch } })
      this.checkResults(results, batch, false)
    }
    const after = await this.getAlbumAssetIds(albumId)
    if (after.size !== wanted.size || [...wanted].some(id => !after.has(id))) {
      throw new Error('Album readback does not equal the combined matching set; retry next run')
    }
    console.log(`Synchronized album ${albumId}: ${wanted.size} matches, ${added} additions, ${stale.length} removals`)
  }

  /** Album enumeration/set comparison adapted from the pinned mafr95 source. */
  private async getAlbumAssetIds (albumId: string): Promise<Set<string>> {
    const ids = new Set<string>()
    let page = 1
    while (true) {
      const res = await searchAssets({ metadataSearchDto: { albumIds: [albumId], page, size: BATCH_SIZE } })
      if (!res.assets || !Array.isArray(res.assets.items)) throw new Error('Incomplete album response')
      for (const asset of res.assets.items) {
        if (typeof asset.id !== 'string' || !asset.id.length) throw new Error('Incomplete album asset ID')
        ids.add(asset.id)
      }
      const next = res.assets.nextPage
      if (next === null) return ids
      if (typeof next !== 'string' || !/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) <= page) {
        throw new Error('Invalid or looping album pagination')
      }
      page = Number(next)
    }
  }

  private checkResults (results: unknown, ids: string[], allowDuplicate: boolean) {
    if (!Array.isArray(results) || results.length !== ids.length) throw new Error('Incomplete bulk membership result')
    const requested = new Set(ids)
    const seen = new Set<string>()
    for (const item of results) {
      if (!item || !requested.has(item.id) || seen.has(item.id)) throw new Error('Invalid bulk membership result')
      seen.add(item.id)
      if (item.success !== true && !(allowDuplicate && item.success === false && item.error === 'duplicate')) {
        throw new Error('One or more album membership operations failed')
      }
    }
  }
}
