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
  excludePersonIds?: string[];
  allowOtherPeople?: boolean;
  sync?: boolean;
}

export interface PersonRule {
  personIds: string[];
  excludePersonIds: string[];
  allowOtherPeople: boolean;
}

export type Link = LinkBase & (
  | { personId: string; personIds?: never }
  | { personId?: never; personIds: string[] }
)
