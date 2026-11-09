'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const functionPath = path.resolve(__dirname, '../dist/function.js')

function loadSubject ({ search = async () => ({ assets: { items: [], nextPage: null } }), add = async () => {}, faces = async () => { throw new Error('Unexpected face lookup') } } = {}) {
  const storeData = new Map()
  const calls = { searches: [], additions: [], writes: [], faces: [] }
  const store = {
    get: key => storeData.get(key),
    set: async (key, value) => {
      calls.writes.push([key, value])
      storeData.set(key, value)
    }
  }
  const sdk = {
    getFaces: async args => {
      calls.faces.push(args)
      return faces(args, calls)
    },
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


const face = id => ({ person: id === null ? null : { id } })

function filteredFixture (assetFaces, overrides = {}) {
  return loadSubject({
    search: async () => ({ assets: { items: Object.keys(assetFaces).map(id => item(id, '2026-01-01')), nextPage: null } }),
    faces: async ({ id }) => assetFaces[id],
    ...overrides
  })
}

test('default all-people rule needs no face-read calls and allows additional people', async () => {
  const { subject, calls } = loadSubject({ search: async () => ({ assets: { items: [item('with-others', '2026-01-01')], nextPage: null } }) })
  await subject.processPerson(multi(['a', 'b']))
  assert.equal(calls.faces.length, 0)
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['with-others'])
})

test('all A and B but not C rejects C and allows unrelated or unnamed faces', async () => {
  const { subject, calls } = filteredFixture({
    pair: [face('a'), face('b')],
    excluded: [face('a'), face('b'), face('c')],
    unrelated: [face('a'), face('b'), face('d')],
    unnamed: [face('a'), face('b'), face(null)]
  })
  await subject.processPerson(multi(['b', 'a'], { excludePersonIds: ['c'] }))
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['pair', 'unrelated', 'unnamed'])
  assert.equal(calls.faces.length, 4)
})

test('only A and C rejects other recognized and unnamed faces but allows repeat detections of A', async () => {
  const { subject, calls } = filteredFixture({
    pair: [face('a'), face('c')],
    other: [face('a'), face('c'), face('b')],
    unnamed: [face('a'), face('c'), face(null)],
    repeated: [face('a'), face('c'), face('a')],
    missing: [face('a')],
    empty: []
  })
  await subject.processPerson(multi(['a', 'c'], { allowOtherPeople: false }))
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['pair', 'repeated'])
})

test('exclusions and strict-only mode can be combined', async () => {
  const { subject, calls } = filteredFixture({ pair: [face('a'), face('b')], other: [face('a'), face('b'), face('d')] })
  await subject.processPerson(multi(['a', 'b'], { excludePersonIds: ['c'], allowOtherPeople: false }))
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['pair'])
})

test('filter options also work with legacy single-person rules', async () => {
  const { subject, calls } = filteredFixture({ alone: [face('personA')], other: [face('personA'), face('b')] })
  await subject.processPerson(legacy({ allowOtherPeople: false }))
  assert.deepEqual(calls.additions[0].bulkIdsDto.ids, ['alone'])
})

test('a changed face list missing a required person is rejected for exclusion rules too', async () => {
  const { subject, calls } = filteredFixture({ stale: [face('a'), face('d')] })
  await subject.processPerson(multi(['a', 'b'], { excludePersonIds: ['c'] }))
  assert.equal(calls.additions.length, 0)
})

test('all rejected candidates cause no empty bulk addition and still checkpoint the completed scan', async () => {
  const { subject, calls, storeData } = filteredFixture({ excluded: [face('a'), face('b'), face('c')] })
  const link = multi(['a', 'b'], { excludePersonIds: ['c'] })
  await subject.processPerson(link)
  assert.equal(calls.additions.length, 0)
  assert.equal(storeData.get(subject.getUpdateKeyName(link)), '2026-01-01')
})

test('filter checkpoint keys are canonical, rule-sensitive, and preserve old default keys', () => {
  const { subject } = loadSubject()
  const original = subject.getUpdateKeyName(multi(['a', 'b']))
  assert.equal(subject.getUpdateKeyName(multi(['b', 'a'], { excludePersonIds: [], allowOtherPeople: true })), original)
  const excluded = subject.getUpdateKeyName(multi(['b', 'a'], { excludePersonIds: ['d', 'c', 'd'] }))
  assert.equal(subject.getUpdateKeyName(multi(['a', 'b'], { excludePersonIds: ['c', 'd'] })), excluded)
  assert.notEqual(excluded, original)
  assert.notEqual(subject.getUpdateKeyName(multi(['a', 'b'], { excludePersonIds: ['c'] })), excluded)
  assert.notEqual(subject.getUpdateKeyName(multi(['a', 'b'], { allowOtherPeople: false })), original)
  assert.notEqual(subject.getUpdateKeyName(multi(['a', 'b'], { allowOtherPeople: false })), excluded)
})

test('invalid exclusion/strict options reject before network and checkpoint writes', async t => {
  const invalid = [
    { excludePersonIds: ['a'] }, { excludePersonIds: 'c' }, { excludePersonIds: null },
    { excludePersonIds: [''] }, { excludePersonIds: [' c'] }, { excludePersonIds: [false] },
    { allowOtherPeople: 'false' }, { allowOtherPeople: null }, { allowOtherPeople: 0 }
  ]
  for (const options of invalid) {
    await t.test(JSON.stringify(options), async () => {
      const { subject, calls } = loadSubject()
      await assert.rejects(subject.processPerson(multi(['a', 'b'], options)))
      assert.equal(calls.searches.length, 0)
      assert.equal(calls.faces.length, 0)
      assert.equal(calls.writes.length, 0)
    })
  }
})

test('face-read failure never advances the checkpoint or silently includes a candidate', async () => {
  const { subject, calls, storeData } = filteredFixture({ one: [] }, { faces: async () => { throw new Error('403 face.read required') } })
  const link = multi(['a', 'b'], { allowOtherPeople: false })
  const key = subject.getUpdateKeyName(link)
  storeData.set(key, 'old')
  await assert.rejects(subject.processPerson(link), /face.read/)
  assert.equal(calls.additions.length, 0)
  assert.equal(calls.writes.length, 0)
  assert.equal(storeData.get(key), 'old')
})

test('malformed face response fails closed instead of proving exclusion', async () => {
  const { subject, calls } = filteredFixture({ one: [face('a'), face('b'), {}] })
  await assert.rejects(subject.processPerson(multi(['a', 'b'], { excludePersonIds: ['c'] })))
  assert.equal(calls.additions.length, 0)
  assert.equal(calls.writes.length, 0)
})

test('negative/exact rules filter on every page without dropping video assets', async () => {
  const { subject, calls } = loadSubject({
    search: async ({ metadataSearchDto: dto }) => ({ assets: { items: [{ ...item(dto.page === 1 ? 'photo' : 'video', '2026-01-01'), type: dto.page === 1 ? 'IMAGE' : 'VIDEO' }], nextPage: dto.page === 1 ? '2' : null } }),
    faces: async () => [face('a'), face('b')]
  })
  await subject.processPerson(multi(['a', 'b'], { excludePersonIds: ['c'], allowOtherPeople: false }))
  assert.deepEqual(calls.additions.map(c => c.bulkIdsDto.ids), [['photo'], ['video']])
  assert.deepEqual(calls.faces.map(c => c.id), ['photo', 'video'])
})


test('full matching ignores incremental state, follows every page, and makes no writes', async () => {
  const { subject, calls, storeData } = loadSubject({ search: async ({ metadataSearchDto: dto }) => ({ assets: { items: [item(dto.page === 1 ? 'old-photo' : 'old-video', '2020-01-01')], nextPage: dto.page === 1 ? '2' : null } }) })
  const link = multi(['a', 'b'], { sync: true })
  storeData.set(subject.getUpdateKeyName(link), '2099-01-01')
  assert.deepEqual([...await subject.getMatchingAssetIds(link)], ['old-photo', 'old-video'])
  assert.ok(calls.searches.every(x => x.metadataSearchDto.updatedAfter === undefined))
  assert.equal(calls.additions.length, 0)
  assert.equal(calls.writes.length, 0)
})

test('full matching applies exclusion/strict rules before returning IDs', async () => {
  const { subject, calls } = filteredFixture({ pair: [face('a'), face('b')], other: [face('a'), face('b'), face('c')] })
  assert.deepEqual([...await subject.getMatchingAssetIds(multi(['a', 'b'], { allowOtherPeople: false }))], ['pair'])
  assert.equal(calls.additions.length, 0)
  assert.equal(calls.writes.length, 0)
})

test('full matching aborts a failed later page rather than returning partial results', async () => {
  const { subject, calls } = loadSubject({ search: async ({ metadataSearchDto: dto }) => {
    if (dto.page === 2) throw new Error('later page failed')
    return { assets: { items: [item('one', '2020-01-01')], nextPage: '2' } }
  } })
  await assert.rejects(subject.getMatchingAssetIds(legacy()), /later page failed/)
  assert.equal(calls.additions.length, 0)
  assert.equal(calls.writes.length, 0)
})

test('full matching rejects looping pagination', async () => {
  const { subject } = loadSubject({ search: async () => ({ assets: { items: [item('one', '2020-01-01')], nextPage: '1' } }) })
  await assert.rejects(subject.getMatchingAssetIds(legacy()), /pagination/i)
})

test('sync option must be a boolean', async () => {
  const { subject, calls } = loadSubject()
  await assert.rejects(subject.processPerson(legacy({ sync: 'true' })))
  assert.equal(calls.searches.length, 0)
})
