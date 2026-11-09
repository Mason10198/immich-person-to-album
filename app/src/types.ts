export interface Config {
  immichServer: string;
  schedule: string;
  users: User[]
}

export interface User {
  apiKey: string;
  personLinks: Link[]
}

interface LinkBase {
  description?: string;
  albumId: string;
  apiKeyShort: string;
}

export type Link = LinkBase & (
  | { personId: string; personIds?: never }
  | { personId?: never; personIds: string[] }
)
