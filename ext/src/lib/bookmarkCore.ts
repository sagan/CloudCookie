import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SerializedBookmarkNode } from './types';

export interface BookmarkTreeNodeLike {
  id?: string;
  title?: string;
  url?: string;
  dateAdded?: number;
  children?: BookmarkTreeNodeLike[];
}

function serializeBookmarkNode(node: BookmarkTreeNodeLike): {
  node: SerializedBookmarkNode;
  bookmarkCount: number;
  folderCount: number;
} {
  if (typeof node.url === 'string') {
    const out: SerializedBookmarkNode = {
      title: node.title || '',
      url: node.url,
    };
    if (typeof node.dateAdded === 'number') {
      out.dateAdded = node.dateAdded;
    }
    return { node: out, bookmarkCount: 1, folderCount: 0 };
  }

  let bookmarkCount = 0;
  let folderCount = 1;
  const children: SerializedBookmarkNode[] = [];
  for (const child of node.children ?? []) {
    const res = serializeBookmarkNode(child);
    children.push(res.node);
    bookmarkCount += res.bookmarkCount;
    folderCount += res.folderCount;
  }

  const out: SerializedBookmarkNode = {
    title: node.title || '',
    children,
  };
  if (typeof node.dateAdded === 'number') {
    out.dateAdded = node.dateAdded;
  }
  return { node: out, bookmarkCount, folderCount };
}

export function normalizeBookmarkTree(tree: BookmarkTreeNodeLike[]): {
  roots: SerializedBookmarkNode[];
  bookmarkCount: number;
  folderCount: number;
} {
  const rootChildren = tree[0]?.children ?? [];
  const roots: SerializedBookmarkNode[] = [];
  let bookmarkCount = 0;
  let folderCount = 0;

  for (const child of rootChildren) {
    const res = serializeBookmarkNode(child);
    roots.push(res.node);
    bookmarkCount += res.bookmarkCount;
    folderCount += res.folderCount;
  }

  return { roots, bookmarkCount, folderCount };
}

export function hashBookmarks(roots: SerializedBookmarkNode[]): string {
  const json = JSON.stringify(roots);
  const bytes = new TextEncoder().encode(json);
  return bytesToHex(sha256(bytes));
}
