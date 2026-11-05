// Compact, normalized shapes sent from the server to the client.

export type Seg =
  | { t: 'text'; v: string }
  | { t: 'mention'; v: string; u: string }
  | { t: 'hash'; v: string }
  | { t: 'cash'; v: string }
  | { t: 'url'; v: string; href: string };

export interface User {
  id: string;
  sn: string; // screen name
  name: string;
  avatar: string;
  verified?: 'blue' | 'gold' | 'gray';
  protected?: boolean;
  following?: boolean;
  followedBy?: boolean;
  // Present on full profiles only
  bio?: Seg[];
  banner?: string;
  location?: string;
  url?: { v: string; href: string };
  joined?: string;
  followers?: number;
  followingCount?: number;
  tweets?: number;
}

export interface Media {
  type: 'photo' | 'video' | 'gif';
  url: string; // base image url (without size params)
  w: number;
  h: number;
  alt?: string;
  src?: string; // mp4 for video / gif
  dur?: number; // ms
}

export interface Card {
  kind: 'link' | 'poll';
  url?: string;
  title?: string;
  desc?: string;
  domain?: string;
  image?: string;
  large?: boolean;
  choices?: { label: string; count: number }[];
  ends?: string;
  closed?: boolean;
}

export interface Tweet {
  id: string;
  user: User;
  text: Seg[];
  time: string; // ISO
  media?: Media[];
  card?: Card;
  quote?: Tweet | null; // null = unavailable
  replyTo?: string; // screen name being replied to
  replyToId?: string;
  convId?: string;
  replies: number;
  rts: number;
  likes: number;
  quotes: number;
  bookmarks: number;
  views?: number;
  liked?: boolean;
  rted?: boolean;
  bookmarked?: boolean;
  lang?: string;
  source?: string;
}

export type Item =
  | { k: string; type: 'tweet'; tweet: Tweet; rtBy?: User; pinned?: boolean; line?: boolean; focal?: boolean }
  | { k: string; type: 'tombstone'; text: string; line?: boolean }
  | { k: string; type: 'user'; user: User }
  | { k: string; type: 'trend'; name: string; ctx?: string; meta?: string; q: string }
  | { k: string; type: 'list'; list: List }
  | { k: string; type: 'notif'; icon: string; text: Seg[]; users: User[]; url?: string; snippet?: string; time?: string }
  | { k: string; type: 'more'; cursor: string; label: string; href?: string };

export interface List {
  id: string;
  name: string;
  desc?: string;
  banner?: string;
  members?: number;
  subscribers?: number;
  owner?: User;
  private?: boolean;
}

export interface Page {
  items: Item[];
  top?: string;
  bottom?: string;
}
