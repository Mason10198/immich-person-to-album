# Immich automatic Person -> Album

Automatically add people (faces) to an album and keep that album up-to-date. You can then share that automatic person-album 
with another user (for example, a shared album of your children).

You can arbitrarily add any face/person to any album. So you could make a "Family" album which contains all your family 
members and is automatically updated.

You can use API keys from any number of Immich users, so the one Docker container can handle doing automatic
albums for all your users.

### Require multiple people together (AND)

Use `personIds` instead of `personId` in a rule to include only photos and videos
where **all** selected people are recognized in the same asset:

```json
{
  "description": "Alex and Sam together",
  "personIds": [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ],
  "albumId": "33333333-3333-4333-8333-333333333333"
}
```

Place this rule in a user's `personLinks` array. Other people may also appear in
the photo or video; this is not an "exactly these faces and no others" filter.
Immich performs the AND match on the server, so the asset response does not need
to include a list of people. Matching depends on Immich's face assignments.

- Existing `personId` rules and their saved progress continue to work unchanged.
- Specify exactly one of `personId` or a nonempty `personIds` array per rule.
- Person ID order and duplicate IDs do not change the rule or its saved progress.
  Changing the set of people starts a new scan for that combination.
- To match **any** selected person (OR), keep using separate `personId` rules
  pointing to the same album. Do not use `personIds` for OR matching.
- For multiple users' libraries, add the same rule under each user's API key.
  Each user must be able to add to the destination album (owner or editor).
- Albums remain add-only: correcting a face assignment does not remove an item
  already added to an album. Existing incremental-sync limitations still apply;
  face assignments changed after a scan may not update the asset's `updatedAt`.

### Development tests

Run `npm ci` followed by `npm run test:unit` from the `app` directory. Tests use
Node.js's built-in test runner with mocked API/storage calls; no Immich server,
API key, Docker, or additional test dependency is required. The existing
`npm test` container smoke-test command is unchanged.

## Setup

Take a copy of the [docker-compose.yml](https://github.com/alangrainger/immich-person-to-album/blob/main/docker-compose.yml) file.

```yaml
services:
  immich-person-to-album:
    image: alangrainger/immich-person-to-album:latest
    restart: always
    volumes:
      - ./data:/data
```

There are two methods for specifying the config options:

### Configure via `config.json` file

1. In the folder which contains your `docker-compose.yml` file, create a `/data/` folder.
2. Inside the `data` folder, put a copy of [config.json](https://github.com/alangrainger/immich-person-to-album/blob/main/data/config.json.example).
3. Edit the `config.json` file as required.

### ...or via Inline configuration

Alternatively, you can add the configuration inline in your `docker-compose.yml` file like this:

```yaml
    volumes:
      - ./data:/data
    environment:
      CONFIG: |
        {
          "immichServer": "http://192.168.0.20:2283",
          "schedule": "*/30 * * * *",
          "users": [
            {
              "apiKey": "XXXXXXXXXX",       # Immich user's API key (read-only access)
              "personLinks": [
                {
                  "description": "Photos of Joe",
                  "personId": "YYYYYYYYYY", # Joe's person ID
                  "albumId": "ZZZZZZZZZZ"   # Shared album ID
                }
              ]
            }
          ]
        }
```

### Create an API key

1. Open Immich on desktop
2. Click on your profile picture
3. Click **Account Settings**
4. Go to API Keys
5. Click **New API Key**
6. Give it a name
7. Add the permissions of `asset.read` and `albumAsset.create`
8. Click **Create**
9. Copy the new API key and put it in your config file 

### Get your person and album IDs

Person IDs: 

- Immich → Explore → People → Click person → Copy ID from URL
- Example URL: http://your-server/people/f3437c84-83f9-4e84-9640-0dcd12efd08e
- Person ID: f3437c84-83f9-4e84-9640-0dcd12efd08e

Album IDs:

- Immich → Albums → Click album → Copy ID from URL
- Example URL: http://your-server/albums/ff85e8c5-32e6-49e0-a0ad-e4dd7ef66bce
- Album ID: ff85e8c5-32e6-49e0-a0ad-e4dd7ef66bce

## Troubleshooting

Make sure you can access your Immich API from inside the `immich-person-to-album` container. Run this command from outside the container, making sure to replace the address with your Immich server address:

```bash
docker exec immich-person-to-album sh -c "wget -qO- http://192.168.0.20:2283/api/server/ping"
```

It will return `{"res":"pong"}` if Immich is accessible to the `immich-person-to-album` container.

## Acknowledgements

Thanks to https://github.com/ajb3932/immich-partner-sharing for the idea and for some of the readme text.

The only reason for making this project is that at time of release, the above project [hadn't been updated](https://github.com/ajb3932/immich-partner-sharing/issues/4) to support Immich 2.x.
