import { Link, Config, PersonRule } from './types'
import { addAssetsToAlbum, searchAssets, getFaces, AssetFaceResponseDto } from '@immich/sdk'
import store from './store'
import path from 'path'

export class PersonToAlbum {
  config: Config

  constructor () {
    this.initConfig()
  }

  /**
   * Read the config.json file or parse the CONFIG env value to get the configuration
   */
  initConfig () {
    try {
      if (process.env.CONFIG) {
        // Attempt to parse docker-compose config string into JSON (if specified)
        this.config = JSON.parse(process.env.CONFIG)
      } else {
        const configJson = require(path.resolve('../data/config.json'))
        if (typeof configJson === 'object') this.config = configJson
      }
    } catch (e) {
      console.log(e)
      console.log('Unable to parse config file.')
    }
  }

  async processPerson (link: Link) {
    const rule = this.getRule(link)
    const { personIds } = rule
    const updateKey = this.getUpdateKeyName(link)
    let nextPage: string | null = '1'
    let mostRecent

    if (link.description) console.log(`=== ${link.description} ===`)
    console.log(`Adding assets containing all of ${personIds.join(', ')} to album ${link.albumId}`)

    while (nextPage !== null) {
      console.log(` - Processing page ${nextPage}`)
      const res = await searchAssets({
        metadataSearchDto: {
          // I'm using `updated` here because this is documented to be the time when
          // the asset was updated in Immich, and nothing to do with the EXIF data.
          // https://immich.app/docs/api/get-asset-info
          // This may also be the case for `created`, but it doesn't specify that in the docs.
          updatedAfter: store.get(updateKey),
          page: parseInt(nextPage, 10), // why is `nextPage` a string and `page` a number? ¯\_(ツ)_/¯
          // Immich matches every person in this array (AND), not any person (OR).
          personIds
        }
      })
      if (res.assets.items.length > 0) {
        // Preserve the existing incremental-sync behavior for single-person rules.
        if (!mostRecent) mostRecent = res.assets.items[0].updatedAt

        const ids = await this.filterAssetIds(rule, res.assets.items)
        if (ids.length > 0) {
          await addAssetsToAlbum({ id: link.albumId, bulkIdsDto: { ids } })
        }
      }
      nextPage = res.assets.nextPage
    }

    // Store the most recent asset update value so we can start processing only newer items next time.
    if (mostRecent) await store.set(updateKey, mostRecent)
    console.log()
  }

  /** Full, read-only scan for album reconciliation; never use incremental state. */
  async getMatchingAssetIds (link: Link): Promise<Set<string>> {
    const rule = this.getRule(link)
    const ids = new Set<string>()
    let page = 1
    while (true) {
      const res = await searchAssets({ metadataSearchDto: { personIds: rule.personIds, page } })
      if (!res.assets || !Array.isArray(res.assets.items)) throw new Error('Incomplete search response')
      for (const id of await this.filterAssetIds(rule, res.assets.items)) ids.add(id)
      const next = res.assets.nextPage
      if (next === null) return ids
      if (typeof next !== 'string' || !/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) <= page) {
        throw new Error('Invalid or looping search pagination')
      }
      page = Number(next)
    }
  }

  private async filterAssetIds (rule: PersonRule, assets: { id: string }[]): Promise<string[]> {
    const ids: string[] = []
    for (const asset of assets) {
      if (rule.excludePersonIds.length > 0 || !rule.allowOtherPeople) {
        // A full face list includes unnamed faces; withPeople alone does not.
        const faces = await getFaces({ id: asset.id })
        if (!this.matchesRule(rule, faces)) continue
      }
      ids.push(asset.id)
    }
    return ids
  }

  /**
   * Get the correctly formatted key name for most-recent updated value in the store
   */
  getUpdateKeyName (link: Link) {
    const rule = this.getRule(link)
    const { personIds } = rule
    // Keep legacy keys intact; canonicalize combinations so order is irrelevant.
    let personKey = personIds.length === 1 ? personIds[0] : `all:${JSON.stringify(personIds)}`
    if (rule.excludePersonIds.length > 0 || !rule.allowOtherPeople) {
      personKey = `rule:${JSON.stringify(rule)}`
    }
    return [link.apiKeyShort, personKey, link.albumId].join(':')
  }

  getPersonIds (link: Link): string[] {
    const hasPersonId = link.personId !== undefined
    const hasPersonIds = link.personIds !== undefined
    if (hasPersonId === hasPersonIds) {
      throw new Error('Specify exactly one of personId or personIds for each rule')
    }
    const ids = hasPersonId ? [link.personId] : link.personIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id =>
      typeof id !== 'string' || id.length === 0 || id !== id.trim()
    )) {
      throw new Error('Person IDs must be nonempty strings without surrounding whitespace')
    }
    return [...new Set(ids as string[])].sort()
  }

  getRule (link: Link): PersonRule {
    if (link.sync !== undefined && typeof link.sync !== 'boolean') throw new Error('sync must be a boolean')
    const personIds = this.getPersonIds(link)
    const excluded = link.excludePersonIds === undefined ? [] : link.excludePersonIds
    if (!Array.isArray(excluded) || excluded.some(id =>
      typeof id !== 'string' || id.length === 0 || id !== id.trim()
    )) {
      throw new Error('excludePersonIds must be an array of nonempty person IDs without surrounding whitespace')
    }
    const excludePersonIds = [...new Set(excluded)].sort()
    if (excludePersonIds.some(id => personIds.includes(id))) {
      throw new Error('A person cannot be both required and excluded')
    }
    if (link.allowOtherPeople !== undefined && typeof link.allowOtherPeople !== 'boolean') {
      throw new Error('allowOtherPeople must be a boolean')
    }
    return { personIds, excludePersonIds, allowOtherPeople: link.allowOtherPeople ?? true }
  }

  matchesRule (rule: PersonRule, faces: AssetFaceResponseDto[]): boolean {
    const recognized = new Set<string>()
    let hasUnnamedFace = false
    for (const face of faces) {
      if (!face || !Object.prototype.hasOwnProperty.call(face, 'person')) {
        throw new Error('Incomplete face response; cannot safely evaluate the rule')
      }
      if (face.person === null) {
        hasUnnamedFace = true
      } else if (typeof face.person?.id === 'string' && face.person.id.length > 0) {
        recognized.add(face.person.id)
      } else {
        throw new Error('Incomplete person identity; cannot safely evaluate the rule')
      }
    }
    // Recheck required faces in case assignments changed since the search.
    if (!rule.personIds.every(id => recognized.has(id))) return false
    if (rule.excludePersonIds.some(id => recognized.has(id))) return false
    if (!rule.allowOtherPeople && (hasUnnamedFace || [...recognized].some(id => !rule.personIds.includes(id)))) {
      return false
    }
    return true
  }
}
