import browser from 'webextension-polyfill';
import { hashBookmarks, normalizeBookmarkTree } from './bookmarkCore';
import type { SerializedBookmarkNode } from './types';

export { hashBookmarks, normalizeBookmarkTree };

export async function collectLocalBookmarks(): Promise<{
  roots: SerializedBookmarkNode[];
  bookmarkCount: number;
  folderCount: number;
}> {
  const tree = await browser.bookmarks.getTree();
  return normalizeBookmarkTree(tree);
}

const ROOT_ALIASES: Record<string, string[]> = {
  'bookmarks bar': ['bookmarks bar', 'bookmarks toolbar', 'favorites bar'],
  'bookmarks toolbar': ['bookmarks toolbar', 'bookmarks bar', 'favorites bar'],
  'other bookmarks': ['other bookmarks', 'unfiled bookmarks'],
  'unfiled bookmarks': ['unfiled bookmarks', 'other bookmarks'],
  'mobile bookmarks': ['mobile bookmarks'],
  'bookmarks menu': ['bookmarks menu', 'other bookmarks'],
};

function findMatchingLocalRoot(
  remoteTitle: string,
  localRoots: browser.Bookmarks.BookmarkTreeNode[],
): browser.Bookmarks.BookmarkTreeNode | undefined {
  const lower = remoteTitle.trim().toLowerCase();
  const exact = localRoots.find((r) => (r.title || '').trim().toLowerCase() === lower);
  if (exact) return exact;

  const aliases = ROOT_ALIASES[lower];
  if (aliases) {
    for (const alias of aliases) {
      const match = localRoots.find((r) => (r.title || '').trim().toLowerCase() === alias);
      if (match) return match;
    }
  }
  return undefined;
}

export interface BookmarkImportResult {
  imported: number;
  skipped: number;
  foldersCreated: number;
  failed: number;
}

async function importIntoFolder(
  nodes: SerializedBookmarkNode[],
  targetFolderId: string,
  existingChildren: browser.Bookmarks.BookmarkTreeNode[],
  stats: BookmarkImportResult,
): Promise<void> {
  const existingUrls = new Set<string>();
  const existingFolders = new Map<string, browser.Bookmarks.BookmarkTreeNode>();

  for (const child of existingChildren) {
    if (typeof child.url === 'string') {
      existingUrls.add(child.url);
    } else {
      const key = (child.title || '').trim().toLowerCase();
      if (!existingFolders.has(key)) {
        existingFolders.set(key, child);
      }
    }
  }

  for (const node of nodes) {
    if (typeof node.url === 'string') {
      if (existingUrls.has(node.url)) {
        stats.skipped += 1;
        continue;
      }
      try {
        await browser.bookmarks.create({
          parentId: targetFolderId,
          title: node.title || node.url,
          url: node.url,
        });
        existingUrls.add(node.url);
        stats.imported += 1;
      } catch {
        stats.failed += 1;
      }
    } else if (Array.isArray(node.children)) {
      const folderKey = (node.title || '').trim().toLowerCase();
      let folder = existingFolders.get(folderKey);
      if (!folder) {
        try {
          folder = await browser.bookmarks.create({
            parentId: targetFolderId,
            title: node.title || 'Folder',
          });
          existingFolders.set(folderKey, folder);
          stats.foldersCreated += 1;
        } catch {
          stats.failed += 1;
          continue;
        }
      }
      const subChildren = folder.children ?? (await browser.bookmarks.getChildren(folder.id));
      await importIntoFolder(node.children, folder.id, subChildren, stats);
    }
  }
}

export async function importBookmarks(
  roots: SerializedBookmarkNode[],
): Promise<BookmarkImportResult> {
  const stats: BookmarkImportResult = {
    imported: 0,
    skipped: 0,
    foldersCreated: 0,
    failed: 0,
  };

  const tree = await browser.bookmarks.getTree();
  const localRoots = tree[0]?.children ?? [];
  if (localRoots.length === 0) {
    throw new Error('No local bookmark root folders available');
  }

  const fallbackRoot =
    findMatchingLocalRoot('Other bookmarks', localRoots) ?? localRoots[localRoots.length - 1]!;

  for (const remoteRoot of roots) {
    if (typeof remoteRoot.url === 'string') {
      await importIntoFolder([remoteRoot], fallbackRoot.id, fallbackRoot.children ?? [], stats);
      continue;
    }

    const matchedRoot = findMatchingLocalRoot(remoteRoot.title || '', localRoots);
    if (matchedRoot) {
      const children = matchedRoot.children ?? (await browser.bookmarks.getChildren(matchedRoot.id));
      await importIntoFolder(remoteRoot.children ?? [], matchedRoot.id, children, stats);
    } else {
      const children = fallbackRoot.children ?? (await browser.bookmarks.getChildren(fallbackRoot.id));
      await importIntoFolder([remoteRoot], fallbackRoot.id, children, stats);
    }
  }

  return stats;
}
