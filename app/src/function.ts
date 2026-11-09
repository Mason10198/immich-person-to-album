import { Link, Config } from './types'
import { addAssetsToAlbum, searchAssets } from '@immich/sdk'
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
    const personIds = this.getPersonIds(link)
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

        await addAssetsToAlbum({
          id: link.albumId,
          bulkIdsDto: {
            ids: res.assets.items.map(x => x.id)
          }
        })
      }
      nextPage = res.assets.nextPage
    }

    // Store the most recent asset update value so we can start processing only newer items next time.
    if (mostRecent) await store.set(updateKey, mostRecent)
    console.log()
  }

  /**
   * Get the correctly formatted key name for most-recent updated value in the store
   */
  getUpdateKeyName (link: Link) {
    const personIds = this.getPersonIds(link)
    // Keep legacy keys intact; canonicalize combinations so order is irrelevant.
    const personKey = personIds.length === 1 ? personIds[0] : `all:${JSON.stringify(personIds)}`
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
}
