'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const functionPath = path.resolve(__dirname, '../dist/function.js')

function loadSubject ({ search = async () => ({ assets: { items: [], nextPage: null } }), add = async () => {} } = {}) {
  const storeData = new Map()
  const calls = { searches: [], additions: [], writes: [] }
  const store = {
    get: key => storeData.get(key),
    set: async (key, value) => {
      calls.writes.push([key, value])
      storeData.set(key, value)
    }
  }
  const sdk = {
    searchAssets: async args => {
      calls.searches.push(args)
      return search(args, calls)
    },
    addAssetsToAlbum: async args => {
      calls.additions.push(args)
      return add(args, calls)
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@immich/sdk') return sdk
    if (request === './store' && parent && parent.filename === functionPath) return { __esModule: true, default: store }
    return originalLoad.call(this, request, parent, isMain)
  }
  let PersonToAlbum
  try {
    delete require.cache[functionPath]
    ;({ PersonToAlbum } = require(functionPath))
  } finally {
    Module._load = originalLoad
  }
  return { subject: Object.create(PersonToAlbum.prototype), calls, storeData }
}

const legacy = (overrides = {}) => ({ apiKeyShort: 'keyA', personId: 'personA', albumId: 'albumA', ...overrides })
const multi = (personIds, overrides = {}) => ({ apiKeyShort: 'keyA', personIds, albumId: 'albumA', ...overrides })
const item = (id, updatedAt) => ({ id, updatedAt })
const dtoOf = call => call.metadataSearchDto

test('legacy link keeps its API filter and checkpoint key', async () => {
  const { subject, calls } = loadSubject({ search: async () => ({ assets: { items: [item('photo', '2024-01-02')], nextPage: null } }) })
  const link = legacy()
  assert.deepEqual(subject.getPersonIds(link), ['personA'])
  assert.equal(subject.getUpdateKeyName(link), 'keyA:personA:albumA')
  await subject.processPerson(link)
  assert.deepEqual(dtoOf(calls.searches[0]).personIds, ['personA'])
  assert.equal(calls.writes[0][0], 'keyA:personA:albumA')
})

test('multi-person IDs are sorted and deduplicated in the native AND search', async () => {
  const { subject, calls } = loadSubject()
  assert.deepEqual(subject.getPersonIds(multi(['z', 'a', 'z', 'm'])), ['a', 'm', 'z'])
  await subject.processPerson(multi(['z', 'a', 'z', 'm']))
  assert.deepEqual(dtoOf(calls.searches[0]).personIds, ['a', 'm', 'z'])
})

test('multi-person checkpoint identity is canonical, scoped, and person-set sensitive', () => {
  const { subject } = loadSubject()
  const key = subject.getUpdateKeyName(multi(['b', 'a']))
  assert.equal(subject.getUpdateKeyName(multi(['a', 'b', 'a'])), key)
  assert.notEqual(subject.getUpdateKeyName(multi(['a'])), key)
  assert.notEqual(subject.getUpdateKeyName(multi(['a', 'b', 'c'])), key)
  assert.notEqual(subject.getUpdateKeyName(multi(['a', 'b'], { apiKeyShort: 'keyB' })), key)
  assert.notEqual(subject.getUpdateKeyName(multi(['a', 'b'], { albumId: 'albumB' })), key)
})

test('invalid person configurations reject before any API calls', async t => {
  const invalid = [
    {},
    { personIds: ['a'], personId: 'a' },
    { personIds: [] },
    { personIds: 'a' },
    { personIds: null },
    { personIds: [''] },
    { personIds: [' a'] },
    { personIds: ['a '] },
    { personIds: [1] },
    { personId: '' },
    { personId: ' a' },
    { personId: 'a ' },
    { personId: 1 }
  ]
  for (const config of invalid) {
    await t.test(JSON.stringify(config), async () => {
      const { subject, calls } = loadSubject()
      await assert.rejects(Promise.resolve().then(() => subject.getPersonIds({ apiKeyShort: 'keyA', albumId: 'albumA', ...config })))
      await assert.rejects(subject.processPerson({ apiKeyShort: 'keyA', albumId: 'albumA', ...config }))
      assert.equal(calls.searches.length, 0)
      assert.equal(calls.additions.length, 0)
      assert.equal(calls.writes.length, 0)
    })
  }
})

test('both photo and video asset IDs are added without result-side person filtering', async () => {
  const { subject, calls } = loadSubject({
    search: async () => ({ assets: { items: [{ ...item('photo-id', '2024-02-01'), type: 'IMAGE' }, { ...item('video-id', '2024-01-31'), type: 'VIDEO' }], nextPage: null } })
  })
  await subject.processPerson(multi(['p2', 'p1']))
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['photo-id', 'video-id'])
})

test('pagination repeats the same sorted multi-person filter on every page', async () => {
  const { subject, calls } = loadSubject({
    search: async args => args.metadataSearchDto.page === 1
      ? { assets: { items: [item('one', '2024-03-01')], nextPage: '2' } }
      : { assets: { items: [item('two', '2024-02-28')], nextPage: null } }
  })
  await subject.processPerson(multi(['z', 'a']))
  assert.equal(calls.searches.length, 2)
  for (const call of calls.searches) assert.deepEqual(dtoOf(call).personIds, ['a', 'z'])
  assert.deepEqual(calls.additions.map(x => x.bulkIdsDto.ids), [['one'], ['two']])
})

test('empty initial result avoids empty bulk write and checkpoint mutation', async () => {
  const { subject, calls, storeData } = loadSubject()
  const key = subject.getUpdateKeyName(legacy())
  storeData.set(key, 'old-checkpoint')
  await subject.processPerson(legacy())
  assert.equal(calls.additions.length, 0)
  assert.equal(calls.writes.length, 0)
  assert.equal(storeData.get(key), 'old-checkpoint')
})

test('empty final page is not added and retains the last nonempty checkpoint', async () => {
  const { subject, calls, storeData } = loadSubject({
    search: async args => args.metadataSearchDto.page === 1
      ? { assets: { items: [item('first', '2024-04-01')], nextPage: '2' } }
      : { assets: { items: [], nextPage: null } }
  })
  const link = legacy()
  const key = subject.getUpdateKeyName(link)
  storeData.set(key, 'older')
  await subject.processPerson(link)
  assert.equal(calls.additions.length, 1)
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['first'])
  assert.equal(calls.writes.at(-1)[1], '2024-04-01')
  assert.notEqual(calls.writes.at(-1)[1], undefined)
})

test('search failure does not advance checkpoint', async () => {
  const { subject, calls, storeData } = loadSubject({ search: async () => { throw new Error('search failed') } })
  const link = legacy()
  const key = subject.getUpdateKeyName(link)
  storeData.set(key, 'old-checkpoint')
  await assert.rejects(subject.processPerson(link), /search failed/)
  assert.equal(storeData.get(key), 'old-checkpoint')
  assert.equal(calls.writes.length, 0)
})

test('album-add failure does not advance checkpoint', async () => {
  const { subject, calls, storeData } = loadSubject({
    search: async () => ({ assets: { items: [item('one', '2024-05-01')], nextPage: null } }),
    add: async () => { throw new Error('add failed') }
  })
  const link = legacy()
  const key = subject.getUpdateKeyName(link)
  storeData.set(key, 'old-checkpoint')
  await assert.rejects(subject.processPerson(link), /add failed/)
  assert.equal(storeData.get(key), 'old-checkpoint')
  assert.equal(calls.writes.length, 0)
})

test('successful add advances the checkpoint; already-present duplicate is harmless', async () => {
  const { subject, calls, storeData } = loadSubject({
    search: async () => ({ assets: { items: [item('already-there', '2024-06-01')], nextPage: null } }),
    add: async () => [{ id: 'already-there', success: false, error: 'duplicate' }]
  })
  const link = legacy()
  const key = subject.getUpdateKeyName(link)
  await subject.processPerson(link)
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['already-there'])
  assert.equal(storeData.get(key), '2024-06-01')
  assert.equal(calls.writes.length, 1)
})
