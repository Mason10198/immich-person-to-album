'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const subjectPath = path.resolve(__dirname, '../dist/sync.js')

function fixture ({ initial = [], matches = {}, scan = async link => matches[link.rule] ?? [], search = async () => null, addResult = async ids => ids.map(id => ({ id, success: true })), removeResult = async ids => ids.map(id => ({ id, success: true })) } = {}) {
  const album = new Set(initial)
  const calls = { init: [], scans: [], searches: [], additions: [], removals: [], processed: [] }
  let activeKey
  const sdk = {
    init: async config => { activeKey = config.apiKey; calls.init.push(activeKey) },
    searchAssets: async args => {
      calls.searches.push({ key: activeKey, args })
      if (search !== undefined && search !== null) {
        const result = await search(args, { album, calls, key: activeKey })
        if (result !== null) return result
      }
      const page = args.metadataSearchDto.page
      const ids = [...album]
      const size = 500
      const from = (page - 1) * size
      return { assets: { items: ids.slice(from, from + size).map(id => ({ id })), nextPage: from + size < ids.length ? String(page + 1) : null } }
    },
    addAssetsToAlbum: async args => {
      const ids = args.bulkIdsDto.ids
      calls.additions.push({ key: activeKey, ids: [...ids] })
      const results = await addResult(ids, { album, key: activeKey })
      if (Array.isArray(results)) for (const result of results) if (result.success) album.add(result.id)
      return results
    },
    removeAssetFromAlbum: async args => {
      const ids = args.bulkIdsDto.ids
      calls.removals.push({ key: activeKey, ids: [...ids], args })
      const results = await removeResult(ids, { album, key: activeKey })
      if (Array.isArray(results)) for (const result of results) if (result.success) album.delete(result.id)
      return results
    }
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@immich/sdk') return sdk
    return originalLoad.call(this, request, parent, isMain)
  }
  let AlbumSync
  try {
    delete require.cache[subjectPath]
    ;({ AlbumSync } = require(subjectPath))
  } finally {
    Module._load = originalLoad
  }
  const pta = {
    config: { immichServer: 'http://immich.invalid', users: [] },
    processPerson: async l => {
      calls.processed.push({ key: activeKey, rule: l.rule })
      const ids = matches[l.rule] ?? []
      if (ids.length) await sdk.addAssetsToAlbum({ id: l.albumId, bulkIdsDto: { ids } })
    },
    getMatchingAssetIds: async link => {
      calls.scans.push({ key: activeKey, rule: link.rule })
      return scan(link, { album, calls, key: activeKey })
    }
  }
  const sync = new AlbumSync(pta)
  const run = async userRules => {
    pta.config.users = userRules.map(([apiKey, personLinks]) => ({ apiKey, personLinks }))
    return await sync.run()
  }
  return { run, calls, album, pta, sync }
}

const link = (albumId = 'album-x', rule = 'rule', options = {}) => ({ albumId, rule, ...options })
const user = (key, ...links) => [key, links]
const unionLinks = (a = 'rule-a', b = 'rule-b') => [user('key-one', link('album-x', a, { sync: true })), user('key-two', link('album-x', b, { sync: true }))]
const pages = calls => calls.searches.map(call => call.args.metadataSearchDto.page)

async function expectGroupFailure (fixture, users) {
  const result = await fixture.run(users)
  assert.equal(result.length, 1)
  assert.equal(result[0].success, false)
  return result
}

test('mirrored album keeps union from all users and removes only stale assets', async () => {
  const f = fixture({ initial: ['a', 'b', 'stale'], matches: { 'rule-a': ['a'], 'rule-b': ['b'] } })
  const result = await f.run(unionLinks())
  assert.equal(result[0].success, true)
  assert.deepEqual([...f.album].sort(), ['a', 'b'])
  assert.deepEqual(f.calls.scans.map(x => x.key), ['key-one', 'key-two'])
  assert.deepEqual(f.calls.removals.flatMap(x => x.ids), ['stale'])
})

test('empty first library preserves assets matched by the second', async () => {
  const f = fixture({ initial: ['second'], matches: { 'rule-a': [], 'rule-b': ['second'] } })
  await f.run(unionLinks())
  assert.deepEqual([...f.album], ['second'])
})

test('scan failure blocks all album writes', async () => {
  const f = fixture({ initial: ['stale'], scan: async l => { if (l.rule === 'rule-b') throw Error('scan error'); return ['new'] } })
  await expectGroupFailure(f, unionLinks())
  assert.equal(f.calls.additions.length + f.calls.removals.length, 0)
})

test('later album page read failure blocks all writes', async () => {
  const f = fixture({ initial: Array.from({ length: 501 }, (_, i) => `asset-${i}`), search: async args => args.metadataSearchDto.page === 2 ? Promise.reject(Error('page failed')) : null })
  await expectGroupFailure(f, unionLinks())
  assert.equal(f.calls.additions.length + f.calls.removals.length, 0)
})

test('partial add failure blocks cleanup', async () => {
  const f = fixture({ initial: ['stale'], matches: { 'rule-a': ['new'], 'rule-b': [] }, addResult: async ids => ids.map(id => ({ id, success: false, error: 'denied' })) })
  await expectGroupFailure(f, unionLinks())
  assert.equal(f.calls.removals.length, 0)
})

test('removal failure is reported as unsuccessful', async () => {
  const f = fixture({ initial: ['stale'], matches: { 'rule-a': [], 'rule-b': [] }, removeResult: async () => ({ success: false, error: 'denied' }) })
  await expectGroupFailure(f, unionLinks())
})

test('non-mirrored other album is add-only and retains existing extras', async () => {
  const f = fixture({ initial: ['old'], matches: { 'rule': ['new'] } })
  const result = await f.run([user('key-one', link('album-y', 'rule'))])
  assert.equal(result[0].success, true)
  assert.deepEqual([...f.album].sort(), ['new', 'old'])
  assert.equal(f.calls.removals.length, 0)
})

test('mixed sync true and missing flags fail closed before lookup or writes', async () => {
  const f = fixture({ initial: ['stale'] })
  await expectGroupFailure(f, [user('key-one', link('album-x', 'rule-a', { sync: true })), user('key-two', link('album-x', 'rule-b'))])
  assert.equal(f.calls.scans.length + f.calls.searches.length + f.calls.additions.length + f.calls.removals.length, 0)
})

test('malformed sync flag fails closed before lookup', async () => {
  const f = fixture()
  await expectGroupFailure(f, [user('key-one', link('album-x', 'rule-a', { sync: 'true' }))])
  assert.equal(f.calls.scans.length + f.calls.searches.length, 0)
})

test('fully empty mirrored union clears album', async () => {
  const f = fixture({ initial: ['old-one', 'old-two'], matches: { 'rule-a': [], 'rule-b': [] } })
  const result = await f.run(unionLinks())
  assert.equal(result[0].success, true)
  assert.deepEqual([...f.album], [])
  assert.equal(f.calls.removals.flatMap(x => x.ids).length, 2)
})

test('album enumeration paginates in batches of at most 500', async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `asset-${i}`)
  const f = fixture({ initial: ids, matches: { 'rule-a': ids, 'rule-b': [] } })
  await f.run(unionLinks())
  assert.deepEqual(pages(f.calls), [1, 2, 3, 1, 2, 3])
  assert.ok(f.calls.searches.every(c => c.args.metadataSearchDto.size <= 500 || c.args.metadataSearchDto.take <= 500))
})

test('multiple rules for one user contribute to same album union', async () => {
  const f = fixture({ matches: { first: ['a'], second: ['b'], third: [] } })
  const result = await f.run([user('key-one', link('album-x', 'first', { sync: true }), link('album-x', 'second', { sync: true })), user('key-two', link('album-x', 'third', { sync: true }))])
  assert.equal(result[0].success, true)
  assert.deepEqual([...f.album].sort(), ['a', 'b'])
})

test('second run is idempotent', async () => {
  const f = fixture({ matches: { 'rule-a': ['a'], 'rule-b': ['b'] } })
  await f.run(unionLinks())
  const writesAfterFirst = f.calls.additions.length + f.calls.removals.length
  await f.run(unionLinks())
  assert.equal(f.calls.additions.length + f.calls.removals.length, writesAfterFirst)
})

test('bulk false, missing, duplicate, or unsuccessful result blocks deletes', async t => {
  for (const [name, answer] of [['false', false], ['missing', []], ['partial', [{ id: 'new', success: true }]], ['duplicate IDs', [{ id: 'new', success: true }, { id: 'new', success: true }]], ['failure', [{ id: 'new', success: false, error: 'failed' }, { id: 'new-two', success: true }]]]) {
    await t.test(name, async () => {
      const f = fixture({ initial: ['stale'], matches: { 'rule-a': ['new', 'new-two'], 'rule-b': [] }, addResult: async () => answer })
      await expectGroupFailure(f, unionLinks())
      assert.equal(f.calls.removals.length, 0)
    })
  }
})

test('readback that is only a partial album is rejected', async () => {
  let reads = 0
  const f = fixture({ matches: { 'rule-a': ['a'], 'rule-b': [] }, search: async args => {
    reads++
    if (reads === 1) return null
    return { assets: { items: [], nextPage: null } }
  } })
  await expectGroupFailure(f, unionLinks())
})

test('matcher runs under each participant SDK key', async () => {
  const f = fixture({ matches: { 'rule-a': ['a'], 'rule-b': ['b'] } })
  await f.run(unionLinks())
  assert.deepEqual(f.calls.scans, [{ key: 'key-one', rule: 'rule-a' }, { key: 'key-two', rule: 'rule-b' }])
})


test('large additions use each contributor key and cleanup is owner-scoped in bounded batches', async () => {
  const a = Array.from({ length: 1001 }, (_, i) => `one-${i}`)
  const stale = Array.from({ length: 600 }, (_, i) => `stale-${i}`)
  const f = fixture({ initial: stale, matches: { 'rule-a': a, 'rule-b': ['two'] } })
  const results = await f.run(unionLinks())
  assert.equal(results[0].success, true)
  assert.equal(f.album.size, 1002)
  assert.ok(f.calls.additions.every(c => c.ids.length <= 500))
  assert.ok(f.calls.removals.every(c => c.ids.length <= 500 && c.key === 'key-one'))
  assert.ok(f.calls.additions.filter(c => c.key === 'key-one').flatMap(c => c.ids).every(id => id.startsWith('one-')))
  assert.deepEqual(f.calls.additions.filter(c => c.key === 'key-two').flatMap(c => c.ids), ['two'])
})

test('already-present duplicate additions are allowed but still require final readback', async () => {
  const f = fixture({ matches: { 'rule-a': ['a'], 'rule-b': [] }, addResult: async (ids, { album }) => {
    ids.forEach(id => album.add(id))
    return ids.map(id => ({ id, success: false, error: 'duplicate' }))
  } })
  assert.equal((await f.run(unionLinks()))[0].success, true)
})

test('looping album pagination fails before writes', async () => {
  const f = fixture({ search: async () => ({ assets: { items: [{ id: 'old' }], nextPage: '1' } }) })
  await expectGroupFailure(f, unionLinks())
  assert.equal(f.calls.additions.length + f.calls.removals.length, 0)
})

test('malformed album pagination fails before writes', async () => {
  const f = fixture({ search: async () => ({ assets: { items: [{ id: 'old' }] } }) })
  await expectGroupFailure(f, unionLinks())
  assert.equal(f.calls.additions.length + f.calls.removals.length, 0)
})

test('an overlapping cycle is skipped before it can switch the global SDK key', async () => {
  let unlock
  let started
  const gate = new Promise(resolve => { unlock = resolve })
  const began = new Promise(resolve => { started = resolve })
  const f = fixture({ scan: async l => {
    if (l.rule === 'rule-a') { started(); await gate }
    return l.rule === 'rule-a' ? ['a'] : ['b']
  } })
  const first = f.run(unionLinks())
  await began
  assert.deepEqual(await f.run(unionLinks()), [])
  assert.deepEqual(f.calls.init, ['key-one'])
  unlock()
  assert.equal((await first)[0].success, true)
  assert.deepEqual([...f.album].sort(), ['a', 'b'])
})
