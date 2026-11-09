import { PersonToAlbum } from './function'
import { AlbumSync } from './sync'
import cron from 'node-cron'

const pta = new PersonToAlbum()
const albums = new AlbumSync(pta)

async function main () {
  console.log(new Date().toISOString())

  // Test connection to Immich
  let immichAvailable = false
  const pingUrl = pta.config.immichServer + '/api/server/ping'
  try {
    const response = await fetch(pingUrl)
    const result = await response.json()
    immichAvailable = result.res === 'pong'
  } catch (e) { }
  if (!immichAvailable) {
    console.log('Unable to ping Immich API on ' + pingUrl)
    console.log('Make sure that URL is accessible to this container.')
    console.log('You can test this by running:')
    console.log(`docker exec immich-person-to-album sh -c "wget -qO- ${pingUrl}"`)
    console.log('The result should be `{"res":"pong"}`')
    return
  }

  await albums.run()
  console.log('Waiting for next scheduled task...')
}

// Send the correct process error code for any uncaught exceptions
// so that Docker can gracefully restart the container
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  process.exit(1)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  process.exit(0)
})

// Run on startup

main()
  .then(() => {
    // Then afterwards run on a schedule
    cron.schedule(pta.config.schedule || '0,30 * * * *', main)
  })
